import * as Comp from "../comp.ts";
import type * as Bend from "../bend.ts";

export type Layout = {
  ks: ("w32" | "w64" | "box")[];
  arms: { k: string; fs: { at: number; lay: Layout }[] }[] | null;
  array?: { element: Layout; arr: boolean; lgs: number };
};
export type HostMetadata = {
  constructors: {
    name: string;
    cid: number;
    arity: number;
    lay: Layout;
    fields: number[];
  }[];
  functions: {
    name: string;
    fid: number;
    params: (Layout | null)[];
    ret: Layout;
    borrows: boolean[];
    gpu: boolean;
  }[];
  closures: {
    fid: number;
    term: Bend.LTerm;
    captures: { id: number; name: string; lay: Layout }[];
    tag?: number;
  }[];
  effects: { name: string; cid: number }[];
  main: { pure: boolean; ret: Layout };
};
export type NativeHost = { source: string; metadata: HostMetadata };
export type HostExports = {
  memory: WebAssembly.Memory;
  init(): void;
  step(budget: number): number;
  resume(count: number): void;
  request_ptr(): number;
  corpus_ptr(): number;
  metadata_ptr(): number;
  fingerprint_ptr(): number;
  host_peek(lo: number, hi: number): number;
  host_keep(lo: number, hi: number): void;
  host_seal(lo: number, hi: number): void;
  host_drop(lo: number, hi: number): void;
  host_alloc(words: number): number;
  host_array(lo: number, hi: number): number;
  _initialize?(): void;
};
/** The fork owns its compiler hooks directly; no staged compiler or patches. */
export async function loadHostCompiler(): Promise<{
  compile_book(book: Bend.Book): string;
  compile_host(book: Bend.Book): NativeHost;
}> {
  return Comp;
}

export async function compileHost(book: Bend.Book): Promise<NativeHost> {
  const compiler = await loadHostCompiler();
  // Give each explicit seam its own non-intrinsic definition. Upstream otherwise
  // inlines native primitives and identifies offloads by the callee's name.
  const aliases = new Map<string, string>();
  let nextAlias = 0;
  const alias = (name: string) => {
    if (!aliases.has(name)) {
      let key: string;
      do {
        key = `WebGPU.bridge.${nextAlias++}`;
      } while (book.tlds[key]);
      aliases.set(name, key);
    }
    return aliases.get(name)!;
  };
  const rewrite = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(rewrite);
    if (!value || typeof value !== "object") return value;
    const t = value as Record<string, unknown>;
    if (t.$ === "Ref" && t.b) return { ...t, k: alias(t.k as string) };
    return Object.fromEntries(
      Object.entries(t).map(([k, v]) => [k, k === "s" ? v : rewrite(v)]),
    );
  };
  const tlds = Object.fromEntries(
    Object.entries(book.tlds).map(([k, d]) => [
      k,
      d.$ === "Def" && d.e ? { ...d, e: rewrite(d.e) as Bend.LTerm } : d,
    ]),
  );
  const api = await import("../bend.ts");
  for (const [name, key] of aliases) {
    const def = book.tlds[name];
    if (def.$ !== "Def") throw new Error(`invalid offload definition ${name}`);
    let body: Bend.LTerm = { $: "Ref", k: name };
    for (let i = 0; i < def.n; i++)
      body = { $: "App", f: body, x: { $: "Var", k: `a${i}`, i } };
    for (let i = def.n - 1; i >= 0; i--)
      body = { $: "Lam", k: `a${i}`, i, f: body };
    tlds[key] = {
      ...def,
      b: false,
      i: undefined,
      u: false,
      v: api.term_higher(body),
      e: body,
    };
  }
  const result: NativeHost = compiler.compile_host({ ...book, tlds });
  result.metadata = JSON.parse(
    JSON.stringify(result.metadata, (k, v) => (k === "s" ? undefined : v)),
  );
  for (const fn of result.metadata.functions)
    for (const [name, key] of aliases) if (fn.name === key) fn.name = name;
  const originalNames = new Map([...aliases].map(([name, key]) => [key, name]));
  const restore = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(restore);
    if (!value || typeof value !== "object") return value;
    const term = value as Record<string, unknown>;
    if (term.$ === "Ref" && originalNames.has(term.k as string))
      return { ...term, k: originalNames.get(term.k as string), b: true };
    return Object.fromEntries(
      Object.entries(term).map(([k, v]) => [k, restore(v)]),
    );
  };
  for (const closure of result.metadata.closures)
    closure.term = restore(closure.term) as Bend.LTerm;
  return result;
}
