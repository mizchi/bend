import { isNode } from "./graph.mjs";
/** @typedef {import('./ir.ts').Word} Word */
/** @typedef {import('./ir.ts').Graph} Graph */
/** @typedef {import('./upstream.ts').Layout} Layout */
/** @type {Layout} */
export const boxed = { ks: ["box"], arms: null };
/** @param {bigint} n @returns {Word} */
const scalar = (n) => [Number(n & 0xffffffffn), Number(n >> 32n)];
/** @param {Word} word */
const integer = ([lo, hi]) => BigInt(lo) | (BigInt(hi) << 32n);

/** Translate values using the layouts emitted by upstream, keeping evaluation in C.
 * @param {import('./ir.ts').Artifact} program
 * @param {import('./upstream.ts').HostMetadata} metadata
 * @param {import('./upstream.ts').HostExports} host
 */
export function createGraphBridge(program, metadata, host) {
  const memory = new BigUint64Array(host.memory.buffer);
  const halves = new Uint32Array(host.memory.buffer);
  const corpus = host.corpus_ptr() / 8;
  const scratch = host.request_ptr() / 8 + 2 + 1023;
  const constructors = new Map(metadata.constructors.map((c) => [c.name, c]));
  const gpuConstructors = new Map(
    program.ir.constructors.map((c) => [c.name, c]),
  );
  /** @param {number} at @param {number} n */
  const wordsAt = (at, n) =>
    Array.from(memory.subarray(corpus + at, corpus + at + n));
  /** @param {'host_keep'|'host_seal'} name @param {bigint} word */
  const callWord = (name, word) => {
    host[name](...scalar(word));
    return memory[scratch];
  };

  /** @param {bigint[]} values @param {Layout[]} layouts @returns {Graph} */
  function exportGraph(values, layouts) {
    /** @type {(()=>void)[]} */ const pending = [];
    /** @type {Graph['nodes']} */
    const nodes = [];
    /** @type {Map<string|number, Word>} */
    const seen = new Map();
    /** @param {string} name @param {()=>Word[]} fields @param {string|number} [key] @returns {Word} */
    const makeNode = (name, fields, key) => {
      if (name === "True" || name === "False")
        return [Number(name === "True"), 0];
      const ctor = gpuConstructors.get(name);
      if (!ctor) throw new Error(`missing GPU constructor ${name}`);
      const previous = key === undefined ? undefined : seen.get(key);
      if (previous !== undefined) return previous;
      if (nodes.length >= 1_000_000)
        throw new Error("native graph budget exhausted");
      /** @type {Word} */ const word = [nodes.length, 0x80000000];
      /** @type {Graph['nodes'][number]} */ const node = {
        tag: ctor.tag,
        fields: [],
      };
      nodes.push(node);
      if (key !== undefined) seen.set(key, word);
      pending.push(() => {
        node.fields = fields();
      });
      return word;
    };
    /** @param {bigint[]} words @param {Layout} lay @returns {Word} */
    const decode = (words, lay) => {
      if (lay.arms !== null) {
        const arm = lay.arms[lay.arms.length > 1 ? Number(words[0]) : 0];
        if (!arm) throw new Error("invalid native constructor discriminant");
        const ctor = constructors.get(arm.k);
        return makeNode(arm.k, () => {
          const fields = Array(
            gpuConstructors.get(arm.k)?.fields.length ?? 0,
          ).fill([0, 0]);
          arm.fs.forEach((f, i) => {
            fields[ctor?.fields[i] ?? i] = decode(words.slice(f.at), f.lay);
          });
          return fields;
        });
      }
      const word = words[0] ?? 0n;
      if (lay.ks[0] !== "box") return scalar(word);
      const tag = Number((word >> 56n) & 127n),
        aux = Number((word >> 40n) & 65535n);
      if (tag === 0) return scalar(word);
      if (tag === 4 || tag === 6) {
        if (!lay.array)
          throw new Error(
            "native Array requires a concrete element layout at the GPU boundary",
          );
        const { element, lgs } = lay.array;
        const at = host.host_array(...scalar(word)),
          depth = (aux & 31) - lgs;
        if (depth < 0 || depth > 16)
          throw new Error("native Array exceeds GPU graph capacity");
        /** @param {number} offset @param {number} level @returns {Word} */
        const tree = (offset, level) =>
          level === 0
            ? makeNode("ALeaf", () => [
                decode(
                  element.ks.map((_, i) =>
                    tag === 6
                      ? memory[corpus + at + offset + i]
                      : BigInt(halves[(corpus + at) * 2 + offset + i]),
                  ),
                  element,
                ),
              ])
            : makeNode("ANode", () => [
                tree(offset, level - 1),
                tree(offset + 2 ** (level - 1 + lgs), level - 1),
              ]);
        return tree(0, depth);
      }
      if (tag === 3) {
        const closure = metadata.closures.find((c) => c.fid === aux);
        if (!closure?.tag)
          throw new Error(`native closure ${aux} has no GPU code`);
        const at = Number(word & ((1n << 40n) - 1n));
        return makeNode(
          `$native:${aux}`,
          () => {
            let offset = 0;
            return closure.captures.map((c) => {
              const result = decode(
                wordsAt(at + offset, c.lay.ks.length),
                c.lay,
              );
              offset += c.lay.ks.length;
              return result;
            });
          },
          `closure:${aux}:${at}`,
        );
      }
      if (tag !== 1 && tag !== 2)
        throw new Error(`unsupported native value tag ${tag}`);
      const ctor = metadata.constructors[aux];
      if (!ctor) throw new Error(`unknown native constructor ${aux}`);
      const at = host.host_peek(...scalar(word));
      const raw =
        tag === 1 ? [word & ((1n << 40n) - 1n)] : wordsAt(at, ctor.arity);
      return makeNode(
        ctor.name,
        () => {
          const fields = Array(
            gpuConstructors.get(ctor.name)?.fields.length ?? 0,
          ).fill([0, 0]);
          if (!ctor.lay.arms)
            throw new Error("native constructor lacks field layout");
          ctor.lay.arms[0].fs.forEach((f, i) => {
            fields[ctor.fields[i]] = decode(raw.slice(f.at), f.lay);
          });
          return fields;
        },
        tag === 2 ? at : undefined,
      );
    };
    let at = 0;
    const roots = layouts.map((lay) => {
      const result = decode(values.slice(at), lay);
      at += lay.ks.length;
      return result;
    });
    while (pending.length) pending.pop()?.();
    return { roots, nodes };
  }

  /** @param {Graph} graph @param {Layout[]} layouts @returns {bigint[]} */
  function importGraph(graph, layouts) {
    /** @type {(()=>void)[]} */ const pending = [];
    /** @type {Map<number,bigint>} */
    const seen = new Map();
    /** @param {Word} word @param {Layout} lay @returns {bigint[]} */
    const encode = (word, lay) => {
      const node = isNode(word) ? graph.nodes[word[0]] : null;
      const name = node
        ? program.ir.constructors.find((c) => c.tag === node.tag)?.name
        : undefined;
      if (lay.arms !== null) {
        const index = lay.arms.findIndex(
          (a) =>
            a.k === name || (!node && a.k === (word[0] ? "True" : "False")),
        );
        if (index < 0) throw new Error(`native layout cannot receive ${name}`);
        const arm = lay.arms[index],
          ctor = constructors.get(arm.k);
        const words = Array(lay.ks.length).fill(0n);
        if (lay.arms.length > 1) words[0] = BigInt(index);
        arm.fs.forEach((f, i) => {
          if (!node || !ctor)
            throw new Error("missing native constructor fields");
          encode(node.fields[ctor.fields[i]], f.lay).forEach((v, j) => {
            words[f.at + j] = v;
          });
        });
        return words;
      }
      if (!node) return [integer(word)];
      if (lay.ks[0] !== "box") throw new Error("native scalar received a node");
      if (name === "ALeaf" || name === "ANode") {
        if (!lay.array)
          throw new Error(
            "native Array requires a concrete element layout at the GPU boundary",
          );
        const { element, arr, lgs } = lay.array;
        /** @type {bigint[][]} */ const elements = [];
        /** @param {Word} value @returns {number} */
        const walk = (value) => {
          if (!isNode(value)) throw new Error("invalid GPU Array node");
          const n = graph.nodes[value[0]],
            ctor = program.ir.constructors.find((c) => c.tag === n.tag);
          if (ctor?.name === "ALeaf") {
            elements.push(encode(n.fields[0], element));
            return 0;
          }
          if (ctor?.name !== "ANode")
            throw new Error("invalid GPU Array constructor");
          const left = walk(n.fields[0]),
            right = walk(n.fields[1]);
          if (left !== right)
            throw new Error("native Array requires equal subtree depths");
          return left + 1;
        };
        const cls = walk(word) + lgs,
          cells = 2 ** cls;
        const at = host.host_alloc(arr ? cells : Math.max(1, cells / 2));
        for (let i = 0; i < cells; i++) {
          const value = elements[Math.floor(i / 2 ** lgs)][i % 2 ** lgs] ?? 0n;
          if (arr) memory[corpus + at + i] = value;
          else halves[(corpus + at) * 2 + i] = Number(value);
        }
        return [
          (BigInt(arr ? 6 : 4) << 56n) | (BigInt(cls) << 40n) | BigInt(at),
        ];
      }
      const previous = seen.get(word[0]);
      if (previous !== undefined) return [callWord("host_keep", previous)];
      const closure = metadata.closures.find((c) => c.tag === node.tag);
      if (closure) {
        const words = closure.captures.flatMap((c, i) =>
          encode(node.fields[i], c.lay),
        );
        const at = words.length ? host.host_alloc(words.length) : 0;
        if (words.length) memory.set(words, corpus + at);
        return [(3n << 56n) | (BigInt(closure.fid) << 40n) | BigInt(at)];
      }
      const ctor = name === undefined ? undefined : constructors.get(name);
      if (!ctor) throw new Error(`missing native constructor ${name}`);
      if (ctor.arity === 0 || (ctor.arity === 1 && ctor.lay.ks[0] === "w32")) {
        const words = encode(word, ctor.lay);
        return [(1n << 56n) | (BigInt(ctor.cid) << 40n) | (words[0] ?? 0n)];
      }
      const at = host.host_alloc(ctor.arity);
      const value = callWord(
        "host_seal",
        (2n << 56n) | (BigInt(ctor.cid) << 40n) | BigInt(at),
      );
      if (value >> 63n) seen.set(word[0], value);
      pending.push(() => memory.set(encode(word, ctor.lay), corpus + at));
      return [value];
    };
    const result = layouts.flatMap((lay, i) => encode(graph.roots[i], lay));
    while (pending.length) pending.pop()?.();
    return result;
  }
  return { exportGraph, importGraph };
}
