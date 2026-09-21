import { createEffects } from "./effects.mjs";
import { copyGraph, isNode } from "./graph.mjs";
/** @typedef {import('./ir.ts').Artifact} Artifact */

const defaults = {
  taskCapacity: 1024,
  stackDepth: 64,
  parallelDepth: 8,
  instructionBudget: 4096,
  maxRounds: 4096,
  heapCapacity: 32768,
};
/** @type {Array<[number, string]>} */
const errors = [
  [1, "task capacity exhausted"],
  [2, "evaluation stack exhausted"],
  [4, "Nat exceeds 2^48-1"],
  [8, "invalid instruction"],
  [16, "heap capacity exhausted"],
  [32, "invalid constructor match"],
  [64, "IO inside a parallel GPU task"],
];

/** @param {string} name @param {number} value @param {number} upper */
function positive(name, value, upper) {
  if (!Number.isSafeInteger(value) || value < 1 || value > upper)
    throw new Error(`invalid ${name}: ${value}`);
}

/**
 * Execute a generated data program. The GPU provider is injected so the
 * same scheduler can use navigator.gpu in a browser or Dawn's Node binding.
 * No CPU evaluator or automatic fallback is used.
 * @param {Artifact} program
 * @param {Partial<typeof defaults> & {gpu?: GPU, entry?: string, graph?: import("./ir.ts").Graph, returnGraph?: boolean, signal?: AbortSignal, io?: import("./effects.mjs").IOOptions, onPrint?:(line:string)=>void}} options
 */
export async function runProgram(program, options = {}) {
  const config = {
    ...defaults,
    heapCapacity: program.ir.constructors.length ? defaults.heapCapacity : 1,
    ...options,
  };
  if (
    program?.abi !== "bend-webgpu-v4" ||
    program.ir?.abi !== program.abi ||
    typeof program.shader !== "string"
  ) {
    throw new Error("unsupported WebGPU program ABI");
  }
  positive("register count", program.registers, 128);
  positive("fork width", program.maxFork, 8);
  positive("constructor width", program.maxFields, 8);
  positive("heapCapacity", config.heapCapacity, 1 << 22);
  positive("taskCapacity", config.taskCapacity, 1 << 20);
  positive("stackDepth", config.stackDepth, 1024);
  positive("instructionBudget", config.instructionBudget, 65536);
  positive("maxRounds", config.maxRounds, 1 << 20);
  if (
    !Number.isInteger(config.parallelDepth) ||
    config.parallelDepth < 0 ||
    config.parallelDepth > 32
  )
    throw new Error("invalid parallelDepth");
  const entry = program.ir.functions.find(
    (fn) => fn.name === (options.entry ?? program.ir.entry),
  );
  if (!entry || !Number.isInteger(entry.entry) || entry.entry < 0)
    throw new Error("missing entry point");
  const gpu = options.gpu ?? globalThis.navigator?.gpu;
  if (!gpu) throw new Error("WebGPU is unavailable");
  const adapter = await gpu.requestAdapter();
  if (!adapter)
    throw new Error(
      "No WebGPU adapter (headless Chromium may need --enable-gpu)",
    );
  const device = await adapter.requestDevice();
  /** @type {GPUBuffer[]} */
  const buffers = [];
  /** @type {string[]} */
  const uncaptured = [];
  device.addEventListener("uncapturederror", (event) =>
    uncaptured.push(event.error.message),
  );
  /** @type {{lost?: GPUDeviceLostInfo}} */
  const state = {};
  void device.lost.then((info) => {
    state.lost = info;
  });
  /** @param {string} label @param {number} size @param {GPUBufferUsageFlags} usage */
  const makeBuffer = (label, size, usage) => {
    const buffer = device.createBuffer({ label, size, usage });
    buffers.push(buffer);
    return buffer;
  };
  try {
    const taskStride = 32 + program.maxFork * 8;
    const frameStride = 8 + program.registers * 8;
    const taskBytes = taskStride * config.taskCapacity;
    const frameBytes = frameStride * config.taskCapacity * config.stackDepth;
    const heapBytes = (16 + program.maxFields * 8) * config.heapCapacity;
    const queueBytes = (2 * config.taskCapacity + config.heapCapacity) * 4;
    if (
      Math.max(taskBytes, frameBytes, heapBytes, queueBytes) >
        Math.min(
          device.limits.maxStorageBufferBindingSize,
          device.limits.maxBufferSize,
        ) ||
      Math.ceil(Math.max(config.taskCapacity, config.heapCapacity) / 64) >
        device.limits.maxComputeWorkgroupsPerDimension
    ) {
      throw new Error(
        "requested task/frame arena exceeds WebGPU device limits",
      );
    }
    const shader = device.createShaderModule({
      label: "Bend data program",
      code: program.shader,
    });
    const diagnostics = (await shader.getCompilationInfo()).messages.filter(
      (m) => m.type === "error",
    );
    if (diagnostics.length)
      throw new Error(
        diagnostics
          .map((m) => `${m.lineNum}:${m.linePos} ${m.message}`)
          .join("\n"),
      );
    const layout = device.createBindGroupLayout({
      entries: [0, 1, 2, 3, 4, 5].map((binding) => ({
        binding,
        visibility: GPUShaderStage.COMPUTE,
        buffer: { type: binding === 3 ? "uniform" : "storage" },
      })),
    });
    const pipelineLayout = device.createPipelineLayout({
      bindGroupLayouts: [layout],
    });
    const pipelines = await Promise.all(
      ["evaluate", "join_tasks", "mark_dead", "recycle", "resume_effect"].map(
        (entryPoint) =>
          device.createComputePipelineAsync({
            layout: pipelineLayout,
            compute: { module: shader, entryPoint },
          }),
      ),
    );
    const tasks = makeBuffer(
      "tasks",
      taskBytes,
      GPUBufferUsage.STORAGE |
        GPUBufferUsage.COPY_SRC |
        GPUBufferUsage.COPY_DST,
    );
    const frames = makeBuffer(
      "frames",
      frameBytes,
      GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    );
    const control = makeBuffer(
      "control",
      48,
      GPUBufferUsage.STORAGE |
        GPUBufferUsage.COPY_SRC |
        GPUBufferUsage.COPY_DST,
    );
    const params = makeBuffer(
      "parameters",
      32,
      GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    );
    const heap = makeBuffer(
      "heap",
      heapBytes,
      GPUBufferUsage.STORAGE |
        GPUBufferUsage.COPY_SRC |
        GPUBufferUsage.COPY_DST,
    );
    const queues = makeBuffer(
      "ready and free pools",
      queueBytes,
      GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    );
    const initialQueues = new Uint32Array(queueBytes / 4);
    for (let i = 1; i < config.taskCapacity; i++)
      initialQueues[config.taskCapacity + i - 1] = i;
    for (let i = 0; i < config.heapCapacity; i++)
      initialQueues[2 * config.taskCapacity + i] = i;

    const heapReadback = makeBuffer(
      "heap readback",
      heapBytes,
      GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    );
    const readback = makeBuffer(
      "control and root",
      60,
      GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    );
    device.queue.writeBuffer(tasks, 0, new Uint32Array([1, 0, 0, 0]));
    device.queue.writeBuffer(frames, 0, new Uint32Array([entry.entry, 0]));
    device.queue.writeBuffer(control, 0, new Uint32Array([1, 0, 0, 0]));
    const bindings = device.createBindGroup({
      layout,
      entries: [tasks, frames, control, params, heap, queues].map(
        (buffer, binding) => ({ binding, resource: { buffer } }),
      ),
    });
    const graph = options.graph ?? { roots: [], nodes: [] };
    if (
      graph.roots.length !== entry.params.length ||
      graph.nodes.length > config.heapCapacity
    )
      throw new Error("invalid entry graph size");
    const heapWords = (16 + program.maxFields * 8) / 4;
    const initialHeap = new Uint32Array(graph.nodes.length * heapWords);
    const retainInput = (/** @type {import('./ir.ts').Word} */ value) => {
      if (!isNode(value)) return;
      if (value[0] >= graph.nodes.length)
        throw new Error("invalid graph reference");
      initialHeap[value[0] * heapWords]++;
    };
    for (const [id, node] of graph.nodes.entries()) {
      const desc = program.ir.constructors.find((c) => c.tag === node.tag);
      if (!desc || desc.fields.length !== node.fields.length)
        throw new Error("invalid graph constructor");
      initialHeap.set([1, node.tag, node.fields.length], id * heapWords + 1);
      initialHeap.set(node.fields.flat(), id * heapWords + 4);
      node.fields.forEach(retainInput);
    }
    graph.roots.forEach(retainInput);
    if (initialHeap.length) device.queue.writeBuffer(heap, 0, initialHeap);
    if (graph.roots.length)
      device.queue.writeBuffer(frames, 8, new Uint32Array(graph.roots.flat()));
    for (let i = graph.nodes.length; i < config.heapCapacity; i++)
      initialQueues[2 * config.taskCapacity + i - graph.nodes.length] = i;
    device.queue.writeBuffer(queues, 0, initialQueues);
    device.queue.writeBuffer(
      control,
      32,
      new Uint32Array([graph.nodes.length]),
    );
    const effects = createEffects(program, options);
    const { stdout, stderr, output } = effects.state;
    const snapshot = async () => {
      const commands = device.createCommandEncoder();
      commands.copyBufferToBuffer(heap, 0, heapReadback, 0, heapBytes);
      device.queue.submit([commands.finish()]);
      await heapReadback.mapAsync(GPUMapMode.READ);
      const data = new Uint32Array(heapReadback.getMappedRange()).slice();
      heapReadback.unmap();
      const read = (/** @type {number} */ id) => {
        const at = id * heapWords;
        if (id >= config.heapCapacity || data[at + 1] !== 1)
          throw new Error("invalid live heap node");
        /** @type {import('./ir.ts').Word[]} */
        const fields = [];
        for (let i = 0; i < data[at + 3]; i++)
          fields.push([data[at + 4 + i * 2], data[at + 5 + i * 2]]);
        return { tag: data[at + 2], fields };
      };
      return Object.assign(read, { data });
    };
    let live = 1,
      taskFree = config.taskCapacity - 1,
      heapFree = config.heapCapacity - graph.nodes.length;
    for (let round = 1; round <= config.maxRounds; round++) {
      options.signal?.throwIfAborted();
      if (state.lost)
        throw new Error(`WebGPU device lost: ${state.lost.message}`);
      device.queue.writeBuffer(
        params,
        0,
        new Uint32Array([
          live,
          config.taskCapacity,
          config.stackDepth,
          config.parallelDepth,
          config.instructionBudget,
          config.heapCapacity,
          taskFree,
          heapFree,
        ]),
      );
      // Reset pool counters after taking their host snapshot; the free/ready
      // arrays are read only until the final recycle pass overwrites them.
      device.queue.writeBuffer(control, 12, new Uint32Array(5));
      const commands = device.createCommandEncoder();
      for (const [index, pipeline] of pipelines.slice(0, 4).entries()) {
        const pass = commands.beginComputePass();
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, bindings);
        pass.dispatchWorkgroups(
          Math.max(
            1,
            Math.ceil(
              [
                live,
                config.taskCapacity,
                config.heapCapacity,
                Math.max(config.heapCapacity, config.taskCapacity),
              ][index] / 64,
            ),
          ),
        );
        pass.end();
      }
      commands.copyBufferToBuffer(control, 0, readback, 0, 48);
      commands.copyBufferToBuffer(tasks, 16, readback, 48, 8);
      commands.copyBufferToBuffer(tasks, 0, readback, 56, 4);
      device.queue.submit([commands.finish()]);
      await readback.mapAsync(GPUMapMode.READ);
      const status = new Uint32Array(readback.getMappedRange()).slice();
      readback.unmap();
      if (uncaptured.length) throw new Error(uncaptured.join("\n"));
      if (status[1])
        throw new Error(
          `Bend WebGPU: ${errors
            .filter(([mask]) => status[1] & mask)
            .map(([, text]) => text)
            .join(", ")}`,
        );
      live = status[3];
      taskFree = status[5];
      heapFree = status[7];
      /** @type {import('./ir.ts').Word} */
      const rawValue = [status[12], status[13]];
      if (status[14] === 4) {
        // A named entry is a pure GPU seam: reject effects before host dispatch.
        if (options.entry)
          throw new Error(
            "GPU call must return a pure data result; IO is not allowed",
          );
        const read = await snapshot();
        const request = read(rawValue[0]);
        const effect = program.ir.effects.find((e) => e.tag === request.tag);
        if (!effect) throw new Error("invalid GPU effect request");
        const incoming = await effects.dispatch(
          effect.name,
          request.fields,
          read,
        );
        if (effects.state.halted)
          return {
            stdout,
            stderr,
            output,
            exitCode: effects.state.exitCode,
            value: /** @type {import('./ir.ts').Word} */ ([0, 0]),
            graph: undefined,
            stats: {
              tasks: status[0],
              rounds: round,
              arenaBytes: taskBytes + frameBytes + heapBytes + queueBytes,
              heapAllocated: status[8],
              heapReclaimed: status[9],
            },
            adapter: {
              vendor: adapter.info.vendor,
              architecture: adapter.info.architecture,
              description: adapter.info.description,
              isFallbackAdapter: adapter.info.isFallbackAdapter,
            },
          };
        const data = read.data;
        const free = [];
        for (let i = 0; i < config.heapCapacity; i++)
          if (data[i * heapWords + 1] === 0) free.push(i);
        if (incoming.nodes.length > free.length)
          throw new Error(
            "Bend WebGPU: heap capacity exhausted importing IO result",
          );
        const ids = free.splice(0, incoming.nodes.length);
        /** @param {import('./ir.ts').Word} v @returns {import('./ir.ts').Word} */
        const translate = (v) => (isNode(v) ? [ids[v[0]], 0x80000000] : v);
        /** @param {import('./ir.ts').Word} v */
        const retain = (v) => {
          if (isNode(v)) data[v[0] * heapWords]++;
        };
        incoming.nodes.forEach((node, i) => {
          const at = ids[i] * heapWords;
          data.fill(0, at, at + heapWords);
          data.set([0, 1, node.tag, node.fields.length], at);
          data.set(node.fields.map(translate).flat(), at + 4);
        });
        incoming.nodes.forEach((node) =>
          node.fields.forEach((v) => retain(translate(v))),
        );
        const value = translate(incoming.roots[0]);
        retain(value); // temporary host root
        device.queue.writeBuffer(heap, 0, data);
        device.queue.writeBuffer(
          queues,
          2 * config.taskCapacity * 4,
          new Uint32Array(free),
        );
        heapFree = free.length;
        device.queue.writeBuffer(control, 40, new Uint32Array(value));
        device.queue.writeBuffer(
          control,
          32,
          new Uint32Array([status[8] + ids.length]),
        );
        const resume = device.createCommandEncoder();
        const pass = resume.beginComputePass();
        pass.setPipeline(pipelines[4]);
        pass.setBindGroup(0, bindings);
        pass.dispatchWorkgroups(1);
        pass.end();
        device.queue.submit([resume.finish()]);
        device.queue.writeBuffer(queues, 0, new Uint32Array([0]));
        live = 1;
      }
      if (status[2]) {
        const resultGraph = options.returnGraph
          ? copyGraph([rawValue], await snapshot())
          : undefined;
        const value = rawValue;
        const text =
          program.ir.output === "Nat"
            ? String(BigInt(value[0]) + (BigInt(value[1]) << 32n))
            : program.ir.output === "Bool"
              ? value[0]
                ? "True"
                : "False"
              : String(value[0]);
        if (!program.ir.print && !options.entry) stdout.push(text);
        return {
          value,
          stdout,
          stderr,
          output,
          exitCode: effects.state.exitCode,
          graph: resultGraph,
          stats: {
            tasks: status[0],
            rounds: round,
            arenaBytes: taskBytes + frameBytes + heapBytes + queueBytes,
            heapAllocated: status[8],
            heapReclaimed: status[9],
          },
          adapter: {
            vendor: adapter.info.vendor,
            architecture: adapter.info.architecture,
            description: adapter.info.description,
            isFallbackAdapter: adapter.info.isFallbackAdapter,
          },
        };
      }
    }
    throw new Error(
      `Bend WebGPU: dispatch budget exhausted after ${config.maxRounds} rounds`,
    );
  } finally {
    for (const buffer of buffers) buffer.destroy();
    device.destroy();
  }
}
