import type * as Bend from "../bend.ts";
import { matchClosure } from "./closure-bridge.ts";
import type { HostMetadata } from "./upstream.ts";
import type {
  Scalar,
  ValueType,
  Value,
  Call,
  Instruction,
  ProgramIR,
  FunctionIR,
  ConstructorIR,
} from "./ir.ts";

type Term = Bend.LTerm;
type Env = Map<number, Value>;
type Next = (value: Value) => number;
type Signature = { params: ValueType[]; result: ValueType };

const binaryU32 = ["add", "sub", "mul", "div", "mod", "and", "or", "xor"];
const compare = ["is_eq", "is_ne", "is_lt", "is_le", "is_gt", "is_ge"];
const primitives = new Map<string, Signature>([
  ...binaryU32.map((op): [string, Signature] => [
    `U32.${op}`,
    { params: ["U32", "U32"], result: "U32" },
  ]),
  ...compare.map((op): [string, Signature] => [
    `U32.${op}`,
    { params: ["U32", "U32"], result: "Bool" },
  ]),
  ...["inc", "not", "shl", "shr"].map((op): [string, Signature] => [
    `U32.${op}`,
    { params: ["U32"], result: "U32" },
  ]),
  ["U32.shln", { params: ["U32", "Nat"], result: "U32" }],
  ["U32.shrn", { params: ["U32", "Nat"], result: "U32" }],
  ["U32.to_nat", { params: ["U32"], result: "Nat" }],
  ["U32.from_nat", { params: ["Nat"], result: "U32" }],
  ["U32.is_zero", { params: ["U32"], result: "Bool" }],
  ["U32.cmp", { params: ["U32", "U32"], result: "Node" }],
  ["U32.show", { params: ["U32"], result: "Node" }],
  ["Nat.show", { params: ["Nat"], result: "Node" }],
  ["Nat.add", { params: ["Nat", "Nat"], result: "Nat" }],
  ["Nat.sub", { params: ["Nat", "Nat"], result: "Nat" }],
  ["Nat.is_lt", { params: ["Nat", "Nat"], result: "Bool" }],
]);

function unsupported(message: string): never {
  throw new Error(`unsupported WebGPU construct: ${message}`);
}
function strip(t: Term): Term {
  return t.$ === "Ann" ? strip(t.x) : t;
}
function scalar(t: Term): ValueType {
  t = strip(t);
  if (t.$ === "Ref" && ["U32", "Nat", "Bool"].includes(t.k))
    return t.k as Scalar;
  if (t.$ === "Var") return "Value";
  if (t.$ === "Typ" || t.$ === "Qnt" || t.$ === "Qua") return "Erased";
  if (t.$ === "App" && spine(t).head.$ === "Var") return "Value";
  if (t.$ === "All" || t.$ === "ADT" || t.$ === "Ref" || t.$ === "App")
    return "Node";
  return unsupported(`type ${t.$}`);
}
function spine(t: Term): {
  head: Term;
  args: Term[];
  domains: (Term | null)[];
} {
  const domains: (Term | null)[] = [];
  const args: Term[] = [];
  t = strip(t);
  while (t.$ === "App") {
    domains.unshift(t.f.$ === "Ann" ? t.f.T : null);
    args.unshift(t.x);
    t = strip(t.f);
  }
  return { head: t, args, domains };
}
function numeral(t: Term): { value: bigint; type: Scalar } | null {
  t = strip(t);
  if (t.$ === "Lit" && typeof t.v === "number")
    return { value: BigInt(t.v), type: "Nat" };
  if (t.$ !== "Ctr") return null;
  if (t.k === "Zero") return { value: 0n, type: "Nat" };
  if (t.k === "True" || t.k === "False")
    return { value: BigInt(t.k === "True"), type: "Bool" };
  if (t.k !== "U32" || t.x.length !== 1) return null;
  let word = strip(t.x[0]);
  let value = 0n;
  let bit = 0n;
  while (word.$ === "Ctr" && word.k === "WCon" && word.x.length === 2) {
    const h = strip(word.x[0]);
    if (bit >= 32n || h.$ !== "Ctr" || !["True", "False"].includes(h.k))
      return null;
    if (h.k === "True") value |= 1n << bit;
    bit++;
    word = strip(word.x[1]);
  }
  return word.$ === "Ctr" && word.k === "WNil" && bit === 32n
    ? { value, type: "U32" }
    : null;
}

/** Lower a checked Book without evaluating the user's computation on the CPU. */
export function lowerBook(
  book: Bend.Book,
  api: Pick<typeof Bend, "term_lower" | "term_higher" | "term_wnf">,
  native?: HostMetadata,
): ProgramIR {
  const instructions: Instruction[] = [];
  const functions = new Map<string, FunctionIR>();
  const strings: string[] = [];
  const closures: ProgramIR["closures"] = [];
  let closureCount = 0;
  const effects: ProgramIR["effects"] = [];
  const constructors = new Map<string, ConstructorIR>();
  function constructor(name: string): ConstructorIR {
    const known = constructors.get(name);
    if (known) return known;
    const ctr = book.ctrs[name];
    if (!ctr) return unsupported(`constructor ${name}`);
    let t = api.term_lower(ctr.T);
    const fields: ValueType[] = [];
    while (t.$ === "All") {
      fields.push(t.q.$ === "None" ? "Erased" : scalar(t.A));
      t = t.B;
    }
    const result = {
      name,
      tag: constructors.size + 1,
      fields: fields.slice(fields.length - ctr.n),
    };
    if (result.fields.length > 8)
      unsupported(`more than eight fields in ${name}`);
    constructors.set(name, result);
    return result;
  }
  const compatible = (a: ValueType, b: ValueType) =>
    a === b || a === "Value" || b === "Value";
  const signatures = new Map<string, Signature>();
  const emit = (instruction: Instruction) => (
    instructions.push(instruction),
    instructions.length - 1
  );
  const isEffect = (name: string) => {
    const def = book.tlds[name];
    if (!def || def.$ !== "Def" || !def.b) return false;
    if (name === "IO.die") return true;
    if (!def.i || name === "IO.spawn" || name.startsWith("Chan.")) return false;
    let t = api.term_lower(def.T);
    for (let i = 0; i < def.n && t.$ === "All"; i++) t = t.B;
    const head = spine(t).head;
    return head.$ === "Ref" && head.k === "IO";
  };
  const definition = (name: string) => {
    const def = book.tlds[name];
    if (
      !def ||
      def.$ !== "Def" ||
      (def.v === null && !isEffect(name)) ||
      (def.i && !isEffect(name)) ||
      def.u
    )
      unsupported(`definition ${name}`);
    return def;
  };
  function argumentTypes(domains: (Term | null)[]): ValueType[] {
    return domains.map((domain) => {
      if (!domain) return "Value"; // Synthetic applications have explicit signatures.
      const type = api.term_wnf(book, api.term_higher(domain));
      if (type.$ !== "All")
        return unsupported("application without a checked function type");
      return type.q.$ === "None" ? "Erased" : "Value";
    });
  }
  function checkedBody(def: Bend.Def): Term {
    if (!def.e) return unsupported("unchecked definition");
    return def.e;
  }
  function signature(name: string): Signature {
    const primitive = primitives.get(name);
    if (primitive) {
      if (!book.tlds[name]?.b) unsupported(`non-Base primitive ${name}`);
      if (name === "U32.cmp") ["LT", "EQ", "GT"].forEach(constructor);
      if (name.endsWith(".show")) ["SNil", "SCon", "Chr"].forEach(constructor);
      return primitive;
    }
    const known = signatures.get(name);
    if (known) return known;
    const def = definition(name);
    const params: ValueType[] = [];
    let type = api.term_lower(def.T);
    while (type.$ === "All" && params.length < def.n) {
      // Checked bodies already instantiate staged functions. Erased values
      // must never be evaluated, even when their types are runtime data.
      params.push(type.q.$ === "None" ? "Erased" : scalar(type.A));
      type = type.B;
    }
    const sig = { params, result: scalar(type) };
    signatures.set(name, sig);
    return sig;
  }
  // Keep an explicit GPU seam even when the callee normally lowers to one intrinsic.
  function intrinsicEntry(name: string, sig: Signature): string {
    const key = "$intrinsic:" + name;
    if (functions.has(key)) return key;
    const dst = sig.params.length;
    const next = emit({ op: "return", value: dst });
    const args = sig.params.map((_, i) => i);
    const entry = emit({ op: "primitive", name, dst, args, next });
    functions.set(key, { name: key, ...sig, entry, registers: dst + 1 });
    return key;
  }
  // IO values are unary thunks. Constructing an action never executes it.
  function action(name: string, fields: ValueType[]): ConstructorIR {
    if (fields.length > 8)
      unsupported(`more than eight effect arguments in ${name}`);
    const key = "$action:" + name;
    const known = constructors.get(key);
    if (known) return known;
    const ctr = { name: key, tag: constructors.size + 1, fields };
    constructors.set(key, ctr);
    closures.push({ tag: ctr.tag, function: key });
    let entry: number, registers: number;
    if (name === "IO.pure") {
      entry = emit({ op: "return", value: 0 });
      registers = 2;
    } else if (name === "IO.bind") {
      const done = emit({ op: "return", value: 5 });
      const run = emit({
        op: "invoke",
        closure: 4,
        argument: 2,
        dst: 5,
        next: done,
        tail: true,
      });
      const bind = emit({
        op: "invoke",
        closure: 1,
        argument: 3,
        dst: 4,
        next: run,
        tail: false,
      });
      entry = emit({
        op: "invoke",
        closure: 0,
        argument: 2,
        dst: 3,
        next: bind,
        tail: false,
      });
      registers = 6;
    } else {
      // Host responses use the ordinary Bend data constructors, including
      // Result errors, strings and lists. Handles remain opaque scalar words.
      for (const k of [
        "Unit",
        "Tuple",
        "Done",
        "Fail",
        "Nil",
        "Con",
        "SNil",
        "SCon",
        "Chr",
        "None",
        "Some",
      ])
        constructor(k);
      const request = {
        name: "$request:" + name,
        tag: constructors.size + 1,
        fields,
      };
      constructors.set(request.name, request);
      const effect = effects.length;
      effects.push({ name, tag: request.tag });
      const dst = fields.length + 1;
      entry = emit({
        op: "effect",
        effect,
        args: fields.map((_, i) => i),
        dst,
        next: emit({ op: "return", value: dst }),
      });
      registers = dst + 1;
    }
    functions.set(key, {
      name: key,
      params: [...fields, "Value"],
      result: "Value",
      entry,
      registers,
    });
    return ctr;
  }
  function compileFunction(
    name: string,
    body?: Term,
    sig?: Signature,
    captures: [number, Value][] = [],
  ): FunctionIR {
    const known = functions.get(name);
    if (known) return known;
    sig ??= signature(name);
    const fn: FunctionIR = {
      name,
      ...sig,
      entry: -1,
      registers: sig.params.length,
    };
    functions.set(name, fn);
    const fresh = (type: ValueType): Value => ({ reg: fn.registers++, type });
    const literals = new Map<number, { value: bigint; type: Scalar }>();
    const constant = (n: bigint, type: ValueType, next: Next) => {
      if (n < 0n || n > (type === "Nat" ? (1n << 48n) - 1n : 0xffffffffn))
        unsupported(`${type} literal out of range`);
      const value = fresh(type);
      if (type === "U32" || type === "Nat" || type === "Bool") literals.set(value.reg, { value: n, type });
      return emit({
        op: "constant",
        dst: value.reg,
        value: [Number(n & 0xffffffffn), Number(n >> 32n)],
        next: next(value),
      });
    };
    const operation = (
      name: string,
      args: Value[],
      type: ValueType,
      next: Next,
    ) => {
      const value = fresh(type);
      return emit({
        op: "primitive",
        name,
        args: args.map((v) => v.reg),
        dst: value.reg,
        next: next(value),
      });
    };
    const returns: Next = (value) => {
      if (!compatible(value.type, fn.result))
        unsupported(`return type of ${name}`);
      return emit({ op: "return", value: value.reg });
    };
    function argumentsOf(
      terms: Term[],
      env: Env,
      next: (values: Value[]) => number,
      types: ValueType[] = [],
      values: Value[] = [],
    ): number {
      if (!terms.length) return next(values);
      const resume = (value: Value) =>
        argumentsOf(terms.slice(1), env, next, types.slice(1), [
          ...values,
          value,
        ]);
      return types[0] === "Erased"
        ? constant(0n, "Erased", resume)
        : expression(terms[0], env, resume);
    }
    function callParts(t: Term): {
      name: string;
      args: Term[];
      sig: Signature;
      gpu: boolean;
    } {
      const { head, args } = spine(t);
      if (head.$ !== "Ref")
        return unsupported(`parallel binding is not a direct function call`);
      const sig = signature(head.k);
      if (args.length !== sig.params.length)
        unsupported(`partial application of ${head.k}`);
      return { name: head.k, args, sig, gpu: !!head.b };
    }
    function checkArgs(name: string, args: Value[], sig: Signature) {
      if (
        args.length !== sig.params.length ||
        args.some((arg, i) => !compatible(arg.type, sig.params[i]))
      ) {
        unsupported(`argument types of ${name}`);
      }
    }
    function invoke(closure: Value, args: Value[], next: Next): number {
      if (!args.length) return next(closure);
      const value = fresh("Value");
      const resume = invoke(value, args.slice(1), next);
      const continuation = instructions[resume];
      return emit({
        op: "invoke",
        closure: closure.reg,
        argument: args[0].reg,
        dst: value.reg,
        next: resume,
        tail: continuation.op === "return" && continuation.value === value.reg,
      });
    }
    function closure(term: Term, env: Env, next: Next): number {
      // Only free variables enter the immutable environment. A shadowing binder
      // must not accidentally retain an unrelated outer value with the same ID.
      const used = new Set<number>();
      function free(t: Term, bound = new Set<number>()) {
        t = strip(t); // Type annotations do not capture runtime values.
        if (t.$ === "Var") {
          if (!bound.has(t.i) && env.has(t.i)) used.add(t.i);
          return;
        }
        if (t.$ === "Lam") {
          free(t.f, new Set(bound).add(t.i));
          return;
        }
        if (t.$ === "Let") {
          t.v.forEach((v) => free(v, bound));
          free(t.f, new Set([...bound, ...t.i]));
          return;
        }
        if (t.$ === "Sub") {
          free(t.v as Term, bound);
          free(t.f, new Set(bound).add(t.i));
          return;
        }
        for (const [key, item] of Object.entries(t)) {
          if (key === "s") continue;
          if (Array.isArray(item))
            item.forEach((x) => {
              if (x?.$) free(x, bound);
            });
          else if (item && typeof item === "object" && "$" in item)
            free(item as Term, bound);
        }
      }
      free(term);
      const matches = native?.closures.flatMap((candidate) => {
        const literalOf = (t: Term) => {
          t = strip(t);
          return t.$ === "Var" && env.has(t.i) ? literals.get(env.get(t.i)!.reg) ?? null : numeral(t);
        };
        const matched = matchClosure(candidate, term,
          t => t.$ === "Var" ? env.get(t.i) : undefined, literalOf);
        if (!matched) return [];
        const key = `$native:${candidate.fid}`;
        const fields = candidate.captures.map(c => matched.get(c.id)!);
        let ctr = constructors.get(key);
        if (!ctr) {
          ctr = { name: key, tag: constructors.size + 1, fields: fields.map(v => v.type) };
          constructors.set(key, ctr);
          closures.push({ tag: ctr.tag, function: key });
          candidate.tag = ctr.tag;
          compileFunction(key, candidate.term, { params: [...ctr.fields, "Value"], result: "Value" },
            candidate.captures.map((c,i) => [c.id, fields[i]]));
        }
        return [{ ctr, fields }];
      });
      if (matches?.length) {
        const { ctr, fields } = matches[0], value = fresh("Node");
        return emit({ op: "construct", tag: ctr.tag, fields: fields.map(v => v.reg), dst: value.reg, next: next(value) });
      }
      const captured = [...used].map(
        (id) => [id, env.get(id)!] as [number, Value],
      );
      if (captured.length > 8) unsupported("more than eight closure captures");
      const key = "$closure:" + closureCount++;
      const ctr = {
        name: key,
        tag: constructors.size + 1,
        fields: captured.map(([, v]) => v.type),
      };
      constructors.set(key, ctr);
      closures.push({ tag: ctr.tag, function: key });
      compileFunction(
        key,
        term,
        { params: [...ctr.fields, "Value"], result: "Value" },
        captured,
      );
      const value = fresh("Node");
      return emit({
        op: "construct",
        tag: ctr.tag,
        fields: captured.map(([, v]) => v.reg),
        dst: value.reg,
        next: next(value),
      });
    }
    function partial(
      head: Term,
      values: Value[],
      sig: Signature,
      next: Next,
    ): number {
      // Reify an under-applied named function as unary closures. Supplied
      // arguments are captured once, rather than re-evaluated on each call.
      const scope: Env = new Map();
      let body = head;
      for (let i = 0; i < sig.params.length; i++) {
        body = { $: "App", f: body, x: { $: "Var", k: "$arg" + i, i: -1 - i } };
        if (i < values.length) scope.set(-1 - i, values[i]);
      }
      for (let i = sig.params.length - 1; i >= values.length; i--)
        body = { $: "Lam", k: "$arg" + i, i: -1 - i, f: body };
      return closure(body, scope, next);
    }
    function apply(term: Term, args: Value[], env: Env, next: Next): number {
      term = strip(term);
      if (!args.length) return expression(term, env, next);
      if (term.$ === "Lam") {
        return apply(
          term.f,
          args.slice(1),
          new Map(env).set(term.i, args[0]),
          next,
        );
      }
      if (term.$ !== "Mat")
        return expression(term, env, (value) => invoke(value, args, next));
      const [value, ...rest] = args;

      const arms = new Map<string, Term>();
      let tail: Term = term;
      while (tail.$ === "Mat") {
        arms.set(tail.k, tail.h);
        tail = strip(tail.m);
      }
      if (
        ![...arms.keys()].every((k) =>
          ["Zero", "Succ", "False", "True"].includes(k),
        )
      ) {
        const branches = [...arms].map(([name, arm]) => {
          const ctr = constructor(name);
          const fields = ctr.fields.map(fresh);
          return {
            tag: ctr.tag,
            fields: fields.map((v) => v.reg),
            next: apply(arm, [...fields, ...rest], env, next),
          };
        });
        return emit({
          op: "match",
          value: value.reg,
          arms: branches,
          fallback:
            tail.$ === "Efq"
              ? undefined
              : apply(tail, [value, ...rest], env, next),
        });
      }
      const isNat = arms.has("Zero") || arms.has("Succ");
      const zero = arms.get(isNat ? "Zero" : "False");
      const nonzero = arms.get(isNat ? "Succ" : "True");
      if (!zero || !nonzero || arms.size !== 2 || tail.$ !== "Efq")
        unsupported(`non-exhaustive scalar match`);
      const zeroPc = apply(zero, rest, env, next);
      const nonzeroPc = !isNat
        ? apply(nonzero, rest, env, next)
        : operation("Nat.pred", [value], "Nat", (pred) =>
            apply(nonzero, [pred, ...rest], env, next),
          );
      return emit({
        op: "branch",
        value: value.reg,
        zero: zeroPc,
        nonzero: nonzeroPc,
      });
    }
    function expression(term: Term, env: Env, next: Next): number {
      term = strip(term);
      if (term.$ === "Lam" || term.$ === "Mat") return closure(term, env, next);
      if (term.$ === "Lit" && typeof term.v === "string") {
        ["SNil", "SCon", "Chr"].forEach(constructor);
        let id = strings.indexOf(term.v);
        if (id < 0) {
          id = strings.length;
          strings.push(term.v);
        }
        const value = fresh("Node");
        return emit({
          op: "text",
          dst: value.reg,
          text: id,
          next: next(value),
        });
      }
      const literal = numeral(term);
      if (literal) return constant(literal.value, literal.type, next);
      if (term.$ === "Var") {
        const value = env.get(term.i);
        return value ? next(value) : unsupported(`unbound variable ${term.k}`);
      }
      if (term.$ === "Sub") {
        if (term.v.$ === "PVar" || term.v.$ === "PCtr")
          return unsupported("pattern substitution");
        return expression(term.v, env, (value) =>
          expression(term.f, new Map(env).set(term.i, value), next),
        );
      }
      if (term.$ === "Let") {
        const binding = term;
        if (binding.v.length !== binding.i.length || !binding.v.length)
          unsupported("empty binding");
        if (binding.v.length === 1) {
          const bind: Next = (v) =>
            expression(binding.f, new Map(env).set(binding.i[0], v), next);
          return binding.q[0].$ === "None"
            ? constant(0n, "Erased", bind)
            : expression(binding.v[0], env, bind);
        }
        // Parallel binds become fork/join only for user function calls. All
        // arguments are evaluated in the outer environment before publication.
        const parts = binding.v.map((v, i) =>
          binding.q[i].$ === "None" ? null : callParts(v),
        );
        if (parts.some((p) => p && primitives.has(p.name)))
          unsupported("parallel primitive binding");
        if (parts.length > 8) unsupported("more than eight parallel branches");
        function prepare(
          index: number,
          calls: Call[],
          values: Value[],
        ): number {
          if (index < parts.length) {
            const part = parts[index];
            if (!part)
              return constant(0n, "Erased", (value) =>
                prepare(index + 1, calls, [...values, value]),
              );
            compileFunction(part.name);
            return argumentsOf(
              part.args,
              env,
              (args) => {
                checkArgs(part.name, args, part.sig);
                const dst = fresh(part.sig.result);
                return prepare(
                  index + 1,
                  [
                    ...calls,
                    {
                      name: part.name,
                      args: args.map((v) => v.reg),
                      dst: dst.reg,
                      gpu: part.gpu,
                    },
                  ],
                  [...values, dst],
                );
              },
              part.sig.params,
            );
          }
          const inner = new Map(env);
          values.forEach((value, i) => inner.set(binding.i[i], value));
          const resume = expression(binding.f, inner, next);
          if (!calls.length) return resume;
          const sequential = calls.reduceRight(
            (pc, call) => emit({ op: "call", call, next: pc, tail: false }),
            resume,
          );
          return emit({ op: "fork", calls, next: resume, sequential });
        }
        return prepare(0, [], []);
      }
      if (term.$ === "Ctr" && term.k === "Succ" && term.x.length === 1) {
        return expression(term.x[0], env, (v) =>
          operation("Nat.succ", [v], "Nat", next),
        );
      }
      if (term.$ === "Ctr") {
        const ctr = constructor(term.k);
        return argumentsOf(
          term.x,
          env,
          (fields) => {
            if (fields.length !== ctr.fields.length)
              unsupported(`constructor arity ${term.k}`);
            const value = fresh("Node");
            return emit({
              op: "construct",
              tag: ctr.tag,
              fields: fields.map((v) => v.reg),
              dst: value.reg,
              next: next(value),
            });
          },
          ctr.fields,
        );
      }
      if (term.$ === "App" || term.$ === "Ref") {
        const { head, args, domains } = spine(term);
        if (head.$ === "Lam" || head.$ === "Mat")
          return argumentsOf(
            args,
            env,
            (values) => apply(head, values, env, next),
            argumentTypes(domains),
          );
        if (head.$ !== "Ref")
          return expression(head, env, (value) =>
            argumentsOf(
              args,
              env,
              (values) => invoke(value, values, next),
              argumentTypes(domains),
            ),
          );
        const ioIntrinsic =
          book.tlds[head.k]?.b &&
          (["IO.bind", "IO.pure"].includes(head.k) || isEffect(head.k));
        if (ioIntrinsic) {
          if (head.b)
            unsupported("GPU calls must be pure; bang on IO is not supported");
          const sig = signature(head.k);
          if (args.length < sig.params.length)
            return argumentsOf(
              args,
              env,
              (values) => partial(head, values, sig, next),
              sig.params,
            );
          if (args.length !== sig.params.length)
            unsupported(`IO arity ${head.k}`);
          return argumentsOf(
            args,
            env,
            (values) => {
              const fields = values.filter(
                (_, i) => sig.params[i] !== "Erased",
              );
              const ctr = action(
                head.k,
                sig.params.filter((type) => type !== "Erased"),
              );
              const value = fresh("Node");
              return emit({
                op: "construct",
                tag: ctr.tag,
                fields: fields.map((v) => v.reg),
                dst: value.reg,
                next: next(value),
              });
            },
            sig.params,
          );
        }
        const sig = signature(head.k);
        if (args.length < sig.params.length)
          return argumentsOf(
            args,
            env,
            (values) => partial(head, values, sig, next),
            sig.params,
          );
        if (args.length > sig.params.length) {
          let call: Term = head;
          for (const x of args.slice(0, sig.params.length))
            call = { $: "App", f: call, x };
          return expression(call, env, (value) =>
            argumentsOf(
              args.slice(sig.params.length),
              env,
              (values) => invoke(value, values, next),
              argumentTypes(domains.slice(sig.params.length)),
            ),
          );
        }
        return argumentsOf(
          args,
          env,
          (values) => {
            checkArgs(head.k, values, sig);
            if (primitives.has(head.k) && !head.b)
              return operation(head.k, values, sig.result, next);
            const callee = primitives.has(head.k)
              ? intrinsicEntry(head.k, sig)
              : compileFunction(head.k).name;
            const value = fresh(sig.result);
            const resume = next(value);
            const continuation = instructions[resume];
            const tail =
              continuation.op === "return" && continuation.value === value.reg;
            return emit({
              op: "call",
              call: {
                name: callee,
                args: values.map((v) => v.reg),
                dst: value.reg,
                gpu: !!head.b,
              },
              next: resume,
              tail,
            });
          },
          sig.params,
        );
      }
      return unsupported(`${term.$} in ${name}`);
    }
    const args = sig.params.map((type, reg) => ({ reg, type }));
    fn.entry = apply(
      body ?? checkedBody(definition(name)),
      args.slice(captures.length),
      new Map(captures.map(([id], i) => [id, args[i]])),
      returns,
    );
    if (fn.registers > 128) unsupported(`more than 128 registers in ${name}`);
    return fn;
  }

  const main = definition("main");
  const body = checkedBody(main);
  const mainType = api.term_lower(main.T);
  const io = spine(mainType).head;
  const print = io.$ === "Ref" && io.k === "IO";
  const output = print ? "Unit" : (scalar(mainType) as Scalar);
  if (!print && !["U32", "Nat", "Bool"].includes(output))
    unsupported("non-scalar main result");
  const entry = "$entry";
  if (print) {
    const mainFn = compileFunction("$main", body, {
      params: [],
      result: "Node",
    });
    const done = emit({ op: "return", value: 2 });
    const run = emit({
      op: "invoke",
      closure: 0,
      argument: 1,
      dst: 2,
      next: done,
      tail: true,
    });
    const zero = emit({ op: "constant", dst: 1, value: [0, 0], next: run });
    const start = emit({
      op: "call",
      call: { name: mainFn.name, args: [], dst: 0 },
      next: zero,
      tail: false,
    });
    functions.set(entry, {
      name: entry,
      params: [],
      result: "Value",
      entry: start,
      registers: 3,
    });
  } else compileFunction(entry, body, { params: [], result: output as Scalar });
  return {
    abi: "bend-webgpu-v4",
    constructors: [...constructors.values()],
    closures,
    effects,
    strings,
    functions: [...functions.values()],
    instructions,
    entry,
    output,
    print,
  };
}
