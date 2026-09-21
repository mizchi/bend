import { runProgram } from "./runtime.mjs";
import { createEffects } from "./effects.mjs";
import { createGraphBridge, boxed } from "./upstream-graph.mjs";
/** @typedef {import('./ir.ts').Artifact} Artifact */

/** Run upstream-generated CPU code in Wasm and dispatch suspended GPU/IO requests.
 * @param {Artifact} program
 * @param {BufferSource} wasm
 * @param {Parameters<typeof runProgram>[1] & {hostBudget?:number,maxHostSteps?:number}} options
 */
export async function runHybrid(program, wasm, options = {}) {
  const budget = options.hostBudget ?? 4096,
    maxSteps = options.maxHostSteps ?? 100000;
  if (
    !Number.isInteger(budget) ||
    budget < 1 ||
    budget > 65536 ||
    !Number.isInteger(maxSteps) ||
    maxSteps < 1 ||
    maxSteps > 1000000
  )
    throw new Error("invalid host execution budget");
  /** @type {import('./upstream.ts').HostExports} */
  let host;
  let diagnostic = "";
  const wasi = {
    /** @param {number} code */
    proc_exit(code) {
      throw new Error(diagnostic.trim() || `upstream Wasm exited ${code}`);
    },
    fd_close() {
      return 8;
    },
    fd_seek() {
      return 8;
    },
    /** @param {number} fd @param {number} iovs @param {number} count @param {number} written */
    fd_write(fd, iovs, count, written) {
      if (fd !== 1 && fd !== 2) return 8;
      const words = new Uint32Array(host.memory.buffer),
        bytes = new Uint8Array(host.memory.buffer);
      let n = 0;
      for (let i = 0; i < count; i++) {
        const start = words[iovs / 4 + i * 2],
          length = words[iovs / 4 + i * 2 + 1];
        diagnostic += new TextDecoder().decode(
          bytes.subarray(start, start + length),
        );
        n += length;
      }
      words[written / 4] = n;
      return 0;
    },
  };
  const module = await WebAssembly.compile(wasm);
  for (const entry of WebAssembly.Module.imports(module))
    if (
      entry.module !== "wasi_snapshot_preview1" ||
      entry.kind !== "function" ||
      !Object.hasOwn(wasi, entry.name)
    )
      throw new Error(
        `unsupported upstream host import ${entry.module}.${entry.name}`,
      );
  const instance = await WebAssembly.instantiate(module, {
    wasi_snapshot_preview1: wasi,
  });
  host = /** @type {import('./upstream.ts').HostExports} */ (
    /** @type {unknown} */ (instance.exports)
  );
  const digest = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(JSON.stringify(program.ir)),
    ),
  );
  const fingerprint = new Uint8Array(
    host.memory.buffer,
    host.fingerprint_ptr(),
    32,
  );
  if (!digest.every((byte, i) => byte === fingerprint[i]))
    throw new Error("Wasm host and program fingerprint mismatch");
  host._initialize?.();
  const bytes = new Uint8Array(host.memory.buffer),
    start = host.metadata_ptr();
  /** @type {import('./upstream.ts').HostMetadata} */
  const metadata = JSON.parse(
    new TextDecoder().decode(bytes.subarray(start, bytes.indexOf(0, start))),
  );
  host.init();
  const memory = new Uint32Array(host.memory.buffer),
    words = new BigUint64Array(host.memory.buffer);
  const at = host.request_ptr() / 4,
    data = at / 2 + 2;
  const bridge = createGraphBridge(program, metadata, host);
  const effects = createEffects(program, options);
  const stats = {
    gpuCalls: 0,
    uploadedNodes: 0,
    downloadedNodes: 0,
    hostSteps: 0,
  };
  /** @param {import('./ir.ts').Word} value */
  const finish = (value = [0, 0]) => ({
    stdout: effects.state.stdout,
    stderr: effects.state.stderr,
    output: effects.state.output,
    exitCode: effects.state.exitCode,
    value,
    stats,
  });
  for (let turn = 0; turn < maxSteps; turn++) {
    options.signal?.throwIfAborted();
    const state = host.step(budget);
    stats.hostSteps++;
    const id = memory[at + 1],
      count = memory[at + 2];
    const values = Array.from(words.subarray(data, data + count));
    if (state === 0) {
      const graph = bridge.exportGraph(values, [metadata.main.ret]);
      const value = program.ir.print
        ? /** @type {import('./ir.ts').Word} */ ([0, 0])
        : graph.roots[0];
      if (!program.ir.print)
        effects.state.stdout.push(
          program.ir.output === "Bool"
            ? value[0]
              ? "True"
              : "False"
            : String(BigInt(value[0]) + (BigInt(value[1]) << 32n)),
        );
      return finish(value);
    }
    if (state === 1) {
      const native = metadata.functions.find((f) => f.fid === id);
      if (!native) throw new Error(`unknown native GPU function ${id}`);
      const entry = program.ir.functions.find(
        (f) => f.name === native.name || f.name === "$intrinsic:" + native.name,
      );
      if (!entry) throw new Error(`missing GPU entry ${native.name}`);
      const layouts = native.params.filter((p) => p !== null);
      const graph = bridge.exportGraph(values, layouts);
      let live = 0;
      graph.roots = native.params.map((p) =>
        p ? graph.roots[live++] : [0, 0],
      );
      const result = await runProgram(program, {
        ...options,
        entry: entry.name,
        graph,
        returnGraph: true,
      });
      if (!result.graph || result.stdout.length)
        throw new Error("GPU call must return a pure data result");
      stats.gpuCalls++;
      stats.uploadedNodes += graph.nodes.length;
      stats.downloadedNodes += result.graph.nodes.length;
      const resultWords = bridge.importGraph(result.graph, [native.ret]);
      let position = 0;
      layouts.forEach((layout, i) =>
        layout.ks.forEach((kind) => {
          const word = values[position++];
          if (kind === "box" && !native.borrows[i])
            host.host_drop(Number(word & 0xffffffffn), Number(word >> 32n));
        }),
      );
      words.set(resultWords, data);
      host.resume(resultWords.length);
    } else if (state === 2) {
      const effect = metadata.effects.find((e) => e.cid === id);
      const name =
        effect?.name ??
        (metadata.constructors[id]?.name === "Halt" ? "IO.die" : undefined);
      if (!name) throw new Error(`unknown native effect ${id}`);
      const graph = bridge.exportGraph(
        values,
        values.map(() => boxed),
      );
      const response = await effects.dispatch(
        name,
        graph.roots,
        (n) => graph.nodes[n],
      );
      if (effects.state.halted) return finish();
      const resultWords = bridge.importGraph(response, [boxed]);
      words.set(resultWords, data);
      host.resume(resultWords.length);
    } else if (state === 3)
      await new Promise((resolve) => setTimeout(resolve, 0));
    else throw new Error(`unknown upstream host state ${state}`);
  }
  throw new Error("Wasm host dispatch budget exhausted");
}
