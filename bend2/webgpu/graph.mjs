/** @typedef {import('./ir.ts').Word} Word */
/** @typedef {import('./ir.ts').GraphNode} GraphNode */
/** @typedef {import('./ir.ts').Artifact} Artifact */
/** @param {Word} value */
export const isNode = (value) => value[1] >>> 31 === 1;

/** Copy a reachable DAG, preserving aliases and translating only node IDs.
 * @param {Word[]} roots @param {(id:number)=>GraphNode} readNode
 * @returns {import('./ir.ts').Graph}
 */
export function copyGraph(roots, readNode) {
  const ids = new Map();
  /** @type {GraphNode[]} */
  const nodes = [];
  const pending = [...roots];
  while (pending.length) {
    const value = pending.pop();
    if (!value || !isNode(value) || ids.has(value[0])) continue;
    ids.set(value[0], nodes.length);
    const node = readNode(value[0]);
    nodes.push(node);
    pending.push(...node.fields);
  }
  /** @param {Word} value @returns {Word} */
  const translate = (value) =>
    isNode(value) ? [ids.get(value[0]), 0x80000000] : [...value];
  return {
    roots: roots.map(translate),
    nodes: nodes.map((n) => ({ tag: n.tag, fields: n.fields.map(translate) })),
  };
}

/** Decode canonical Bend String/Char nodes; user computation has already run.
 * @param {Artifact} program @param {Word} value @param {(id:number)=>GraphNode} readNode
 */
export function formatText(program, value, readNode) {
  const tags = new Map(program.ir.constructors.map((c) => [c.tag, c.name]));
  const pending = [value];
  const pieces = [];
  let steps = 0;
  while (pending.length) {
    if (++steps > 1_000_000) throw new Error("text output budget exhausted");
    const word = pending.pop();
    if (!word) break;
    if (!isNode(word)) throw new Error("invalid text value");
    const node = readNode(word[0]);
    const name = tags.get(node.tag);
    const item = node.fields[0];
    switch (name) {
      case "SNil":
        break;
      case "SCon":
        pending.push(node.fields[1], item);
        break;
      case "Chr":
        pieces.push(String.fromCodePoint(item[0]));
        break;
      default:
        throw new Error(`unsupported text node: ${name}`);
    }
  }
  return pieces.join("");
}
