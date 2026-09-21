import { isNode, formatText } from "./graph.mjs";
/** @typedef {import('./ir.ts').Word} Word */
/** @typedef {import('./ir.ts').GraphNode} GraphNode */
/** @typedef {import('./ir.ts').Artifact} Artifact */
/** @typedef {number | bigint | string | {constructor:string, fields:HostValue[]}} HostValue */
/** @typedef {{stream:'stdout'|'stderr',text:string}} Output */
/** @typedef {{text:(word:Word)=>string, number:(word:Word)=>bigint,
 * node:(word:Word)=>{constructor:string,fields:Word[]}, signal?:AbortSignal}} EffectContext */
/** @typedef {(args:Word[],context:EffectContext)=>HostValue|Promise<HostValue>} EffectHandler */
/** @typedef {{args?:string[],env?:Record<string,string>,now?:()=>bigint,
 * randomU32?:()=>number,onOutput?:(event:Output)=>void,handlers?:Record<string,EffectHandler>}} IOOptions */
/** @param {string} constructor @param {...HostValue} fields @returns {HostValue} */
export const data = (constructor, ...fields) => ({ constructor, fields });
/** @param {HostValue} value */
export const done = (value) => data("Done", value);
/** @param {number} code @param {string} message */
export const fail = (code, message) =>
  data("Fail", data("Tuple", code, message));

/** Serialize a host response into ordinary Bend constructors. No host pointers
 * or JS objects cross the Wasm/WebGPU boundary.
 * @param {Artifact} program @param {HostValue} value @returns {import('./ir.ts').Graph}
 */
export function encodeValue(program, value) {
  const tags = new Map(program.ir.constructors.map((c) => [c.name, c]));
  /** @type {GraphNode[]} */ const nodes = [];
  /** @param {string} name @param {Word[]} fields @returns {Word} */
  const node = (name, fields) => {
    const ctr = tags.get(name);
    if (!ctr || ctr.fields.length !== fields.length)
      throw new Error(`invalid host constructor ${name}`);
    if (nodes.length >= 1_000_000)
      throw new Error("host response graph budget exhausted");
    const id = nodes.length;
    nodes.push({ tag: ctr.tag, fields });
    return [id, 0x80000000];
  };
  /** @type {Word[]} */ const roots = [[0, 0]];
  /** @type {{value:HostValue,target:Word[],index:number}[]} */
  const pending = [{ value, target: roots, index: 0 }];
  while (pending.length) {
    const job = pending.pop();
    if (!job) break;
    const value = job.value;
    /** @type {Word} */ let word;
    if (typeof value === "number" || typeof value === "bigint") {
      if (typeof value === "number" && !Number.isSafeInteger(value))
        throw new Error("invalid host scalar");
      const n = BigInt(value);
      if (n < 0n || n > 0xffffffffffffn)
        throw new Error("host scalar exceeds Nat range");
      word = [Number(n & 0xffffffffn), Number(n >> 32n)];
    } else if (typeof value === "string") {
      word = node("SNil", []);
      const chars = Array.from(value);
      for (let i = chars.length - 1; i >= 0; i--)
        word = node("SCon", [
          node("Chr", [[chars[i].codePointAt(0) ?? 0, 0]]),
          word,
        ]);
    } else {
      const fields = value.fields.map(() => /** @type {Word} */ ([0, 0]));
      word = node(value.constructor, fields);
      value.fields.forEach((value, index) =>
        pending.push({ value, target: fields, index }),
      );
    }
    job.target[job.index] = word;
  }
  return { roots, nodes };
}

/** @param {number} ms @param {AbortSignal} [signal] */
async function sleep(ms, signal) {
  // JS timers clamp longer delays to 1 ms. Split the full U32 range instead.
  do {
    signal?.throwIfAborted();
    const duration = Math.min(ms, 0x7fffffff);
    await new Promise((resolve, reject) => {
      const abort = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        reject(signal?.reason);
      };
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", abort);
        resolve(undefined);
      }, duration);
      signal?.addEventListener("abort", abort, { once: true });
    });
    ms -= duration;
  } while (ms > 0);
}

/** Shared host effect dispatcher. Capabilities are injected explicitly, which
 * makes the same artifact usable in a browser and in Node/Dawn.
 * @param {Artifact} program
 * @param {{io?:IOOptions,signal?:AbortSignal,onPrint?:(line:string)=>void}} options
 */
export function createEffects(program, options) {
  const io = options.io ?? {};
  /** @type {string[]} */ const stdout = [];
  /** @type {string[]} */ const stderr = [];
  /** @type {Output[]} */ const output = [];
  const state = {
    stdout,
    stderr,
    output,
    exitCode: 0,
    halted: false,
  };
  /** @param {'stdout'|'stderr'} stream @param {string} text @param {boolean} newline */
  const write = (stream, text, newline) => {
    (stream === "stdout" ? stdout : stderr).push(text);
    const event = { stream, text: text + (newline ? "\n" : "") };
    output.push(event);
    io.onOutput?.(event);
    if (stream === "stdout") options.onPrint?.(text);
  };
  /** @param {string} name @param {Word[]} args @param {(id:number)=>GraphNode} read */
  async function dispatch(name, args, read) {
    options.signal?.throwIfAborted();
    /** @type {EffectContext} */
    const context = {
      text: (word) => formatText(program, word, read),
      number: (word) => {
        if (isNode(word) || word[1] > 65535)
          throw new Error("expected host scalar");
        return BigInt(word[0]) + (BigInt(word[1]) << 32n);
      },
      node: (word) => {
        if (!isNode(word)) throw new Error("expected host data");
        const node = read(word[0]),
          ctr = program.ir.constructors.find((c) => c.tag === node.tag);
        if (!ctr) throw new Error("invalid host data");
        return { constructor: ctr.name, fields: node.fields };
      },
      signal: options.signal,
    };
    /** @type {HostValue} */ let value = data("Unit");
    switch (name) {
      case "IO.print":
      case "IO.write":
      case "IO.print_err": {
        write(
          name === "IO.print_err" ? "stderr" : "stdout",
          context.text(args[0]),
          name !== "IO.write",
        );
        break;
      }
      case "IO.args":
        value = data("Nil");
        for (let i = (io.args?.length ?? 0) - 1; i >= 0; i--)
          value = data("Con", (io.args ?? [])[i], value);
        break;
      case "IO.get_env": {
        const key = context.text(args[0]);
        value =
          io.env && Object.hasOwn(io.env, key)
            ? done(io.env[key])
            : fail(2, "Environment variable not found");
        break;
      }
      case "IO.now":
        value = io.now?.() ?? BigInt(Math.floor(performance.now()));
        break;
      case "IO.random_u32": {
        const n =
          io.randomU32?.() ?? crypto.getRandomValues(new Uint32Array(1))[0];
        if (!Number.isInteger(n) || n < 0 || n > 0xffffffff)
          throw new Error("invalid random U32");
        value = done(n);
        break;
      }
      case "IO.sleep":
        await sleep(Number(context.number(args[0])), options.signal);
        break;
      case "IO.die":
        state.exitCode = Number(context.number(args[0]));
        state.halted = true;
        write("stderr", context.text(args[1]), true);
        break;
      default: {
        const handler = io.handlers?.[name];
        if (!handler)
          throw new Error(`Host IO capability unavailable: ${name}`);
        value = await handler(args, context);
      }
    }
    options.signal?.throwIfAborted();
    return encodeValue(program, value);
  }
  return { state, dispatch };
}
