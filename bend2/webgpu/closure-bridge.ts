import type * as Bend from "../bend.ts";
import type { Value } from "./ir.ts";
import type { HostMetadata } from "./upstream.ts";
type Term = Bend.LTerm;

/** Alpha-match the upstream closure body, treating its live captures as holes.
 * The result binds native captures to already-evaluated GPU registers.
 */
export function matchClosure(
  native: HostMetadata["closures"][number],
  actual: Term,
  valueOf: (term: Term) => Value | undefined,
  literalOf: (term: Term) => { value: bigint; type: string } | null,
): Map<number, Value> | null {
  const captures = new Set(native.captures.map((c) => c.id));
  const found = new Map<number, Value>();
  const strip = (t: Term): Term => (t.$ === "Ann" ? strip(t.x) : t);
  function match(a: Term, b: Term, bound = new Map<number, number>()): boolean {
    a = strip(a);
    b = strip(b);
    if (a.$ === "Var") {
      if (bound.has(a.i)) return b.$ === "Var" && bound.get(a.i) === b.i;
      if (!captures.has(a.i)) return b.$ === "Var" && a.k === b.k;
      const value = valueOf(b);
      if (!value || (found.has(a.i) && found.get(a.i)!.reg !== value.reg))
        return false;
      found.set(a.i, value);
      return true;
    }
    const an = literalOf(a),
      bn = literalOf(b);
    if (an || bn)
      return !!an && !!bn && an.value === bn.value && an.type === bn.type;
    if (a.$ !== b.$) return false;
    if (a.$ === "Ref" && b.$ === "Ref" && !!a.b !== !!b.b) return false;
    if (a.$ === "Lam" && b.$ === "Lam")
      return match(a.f, b.f, new Map(bound).set(a.i, b.i));
    if (a.$ === "Let" && b.$ === "Let") {
      if (
        a.v.length !== b.v.length ||
        !a.v.every((v, i) => match(v, b.v[i], bound))
      )
        return false;
      const inner = new Map(bound);
      a.i.forEach((id, i) => inner.set(id, b.i[i]));
      return match(a.f, b.f, inner);
    }
    const aa = a as unknown as Record<string, unknown>,
      bb = b as unknown as Record<string, unknown>;
    for (const key of Object.keys(aa)) {
      if (["s", "q", "T", "i"].includes(key)) continue;
      const x = aa[key],
        y = bb[key];
      if (Array.isArray(x)) {
        if (
          !Array.isArray(y) ||
          x.length !== y.length ||
          !x.every((t, i) => (t?.$ ? match(t, y[i], bound) : t === y[i]))
        )
          return false;
      } else if (x && typeof x === "object" && "$" in x) {
        if (
          !y ||
          typeof y !== "object" ||
          !("$" in y) ||
          !match(x as Term, y as Term, bound)
        )
          return false;
      } else if (key === "b" ? !!x !== !!y : x !== y) return false;
    }
    return true;
  }
  return match(native.term, actual) && found.size === captures.size
    ? found
    : null;
}
