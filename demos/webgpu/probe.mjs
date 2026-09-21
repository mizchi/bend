/**
 * @typedef {[number, number, number, number]} Input
 * Input is [a.low, a.high, b.low, b.high], all unsigned 32-bit words.
 * @typedef {{queueCapacity?: number}} Options
 */

const LIMITS = ["maxStorageBufferBindingSize", "maxBufferSize",
  "maxComputeWorkgroupStorageSize", "maxComputeInvocationsPerWorkgroup",
  "maxComputeWorkgroupsPerDimension"];
const limitsOf = (limits) => Object.fromEntries(LIMITS.map((key) => [key, limits[key]]));

/**
 * Run the Term / two-pass queue probe. This does not execute Bend source.
 * @param {Input[]} inputs
 * @param {Options} options
 * @returns {Promise<{records: number[][], reservations: number, overflows: number, environment: object}>}
 */
export async function runProbe(inputs, { queueCapacity = inputs.length } = {}) {
  if (!inputs.length || inputs.some((row) => row.length !== 4 || row.some(
    (word) => !Number.isInteger(word) || word < 0 || word > 0xffffffff))) {
    throw new Error("inputs must contain four u32 words per case");
  }
  if (!Number.isInteger(queueCapacity) || queueCapacity < 1 || queueCapacity > inputs.length) {
    throw new Error("queueCapacity must be between 1 and the input count");
  }
  if (!navigator.gpu) throw new Error("WebGPU is unavailable in this context");
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error("No WebGPU adapter; Chromium headless may need --enable-gpu");
  const device = await adapter.requestDevice();
  const buffers = [];
  const errors = [];
  device.addEventListener("uncapturederror", (event) => errors.push(event.error.message));
  const makeBuffer = (label, size, usage) => {
    const buffer = device.createBuffer({ label, size, usage });
    buffers.push(buffer);
    return buffer;
  };
  try {
    const environment = {
      vendor: adapter.info.vendor, architecture: adapter.info.architecture,
      device: adapter.info.device, description: adapter.info.description,
      isFallbackAdapter: adapter.info.isFallbackAdapter,
      adapterLimits: limitsOf(adapter.limits), deviceLimits: limitsOf(device.limits),
      features: [...adapter.features].sort(),
      wgslLanguageFeatures: [...navigator.gpu.wgslLanguageFeatures].sort(),
      userAgent: navigator.userAgent,
    };
    const size = inputs.length * 48;
    const groups = Math.ceil(inputs.length / 64);
    if (Math.max(size, 16 + queueCapacity * 16) > device.limits.maxStorageBufferBindingSize
      || groups > device.limits.maxComputeWorkgroupsPerDimension) {
      throw new Error("Probe exceeds the device's default limits");
    }
    const source = await Promise.all(["term.wgsl", "probe.wgsl"].map(async (name) => {
      const response = await fetch(new URL(name, import.meta.url));
      if (!response.ok) throw new Error(`Failed to load ${name}: ${response.status}`);
      return response.text();
    }));
    const shader = device.createShaderModule({ code: source.join("\n") });
    const diagnostics = (await shader.getCompilationInfo()).messages.filter((m) => m.type === "error");
    if (diagnostics.length) throw new Error(diagnostics.map((m) => m.message).join("\n"));
    const layout = device.createBindGroupLayout({ entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
      { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
    ] });
    const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [layout] });
    const pipelines = await Promise.all(["produce", "consume"].map((entryPoint) =>
      device.createComputePipelineAsync({ layout: pipelineLayout, compute: { module: shader, entryPoint } })));
    const input = makeBuffer("input", inputs.length * 16, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);
    const queue = makeBuffer("queue", 16 + queueCapacity * 16, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC);
    const output = makeBuffer("output", size, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC);
    const readback = makeBuffer("readback", size + 8, GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST);
    device.queue.writeBuffer(input, 0, new Uint32Array(inputs.flat()));
    const bindings = device.createBindGroup({ layout, entries: [input, queue, output].map(
      (buffer, binding) => ({ binding, resource: { buffer } })) });
    const commands = device.createCommandEncoder();
    // Separate pass boundaries establish ordering; the relaxed atomic counter
    // alone would not make payload writes visible to consumers.
    for (const pipeline of pipelines) {
      const pass = commands.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bindings);
      pass.dispatchWorkgroups(groups);
      pass.end();
    }
    commands.copyBufferToBuffer(output, 0, readback, 0, size);
    commands.copyBufferToBuffer(queue, 0, readback, size, 8);
    device.queue.submit([commands.finish()]);
    await readback.mapAsync(GPUMapMode.READ);
    const words = new Uint32Array(readback.getMappedRange()).slice();
    readback.unmap();
    if (errors.length) throw new Error(errors.join("\n"));
    return {
      records: inputs.map((_, i) => Array.from(words.subarray(i * 12, i * 12 + 12))),
      reservations: words[size / 4], overflows: words[size / 4 + 1], environment,
    };
  } finally {
    for (const buffer of buffers) buffer.destroy();
    device.destroy();
  }
}
