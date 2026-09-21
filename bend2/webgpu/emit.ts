import { emitText } from "./emit-text.ts";
import type { ProgramIR, Instruction, Call } from "./ir.ts";

/** Emit a program-specific WGSL switch over the structured data IR. */
export function emitWGSL(ir: ProgramIR, template: string) {
  const registers = Math.max(1, ...ir.functions.map((f) => f.registers));
  const maxFork = Math.max(
    1,
    ...ir.instructions.map((i) => (i.op === "fork" ? i.calls.length : 0)),
  );
  const maxFields = Math.max(1, ...ir.constructors.map((c) => c.fields.length));
  const functions = new Map(ir.functions.map((f) => [f.name, f]));
  const r = (reg: number) => `frames[base].regs[${reg}u]`;
  const pc = (next: number) => `frames[base].pc = ${next}u;`;
  function primitive(name: string, args: number[]): string {
    const a = r(args[0]);
    const b = args.length > 1 ? r(args[1]) : "vec2u(0u)";
    const binary: Record<string, string> = {
      add: "+",
      sub: "-",
      mul: "*",
      and: "&",
      or: "|",
      xor: "^",
    };
    const comparisons: Record<string, string> = {
      is_eq: "==",
      is_ne: "!=",
      is_lt: "<",
      is_le: "<=",
      is_gt: ">",
      is_ge: ">=",
    };
    if (name === "U32.cmp") {
      const tag = (k: string) => ir.constructors.find((c) => c.name === k)!.tag;
      return `node_nullary(select(select(${tag("GT")}u, ${tag("EQ")}u, ${a}.x == ${b}.x), ${tag("LT")}u, ${a}.x < ${b}.x))`;
    }
    if (name === "U32.show" || name === "Nat.show") return `text_decimal(${a})`;
    const [type, op] = name.split(".");
    if (type === "U32") {
      if (binary[op]) return `vec2u(${a}.x ${binary[op]} ${b}.x, 0u)`;
      if (comparisons[op])
        return `vec2u(select(0u, 1u, ${a}.x ${comparisons[op]} ${b}.x), 0u)`;
      switch (op) {
        case "inc":
          return `vec2u(${a}.x + 1u, 0u)`;
        case "not":
          return `vec2u(~${a}.x, 0u)`;
        case "shl":
          return `vec2u(${a}.x << 1u, 0u)`;
        case "shr":
          return `vec2u(${a}.x >> 1u, 0u)`;
        case "shln":
          return `word_shl32(${a}, ${b})`;
        case "shrn":
          return `word_shr32(${a}, ${b})`;
        case "div":
          return `vec2u(safe_div(${a}.x, ${b}.x), 0u)`;
        case "mod":
          return `vec2u(safe_mod(${a}.x, ${b}.x), 0u)`;
        case "is_zero":
          return `vec2u(select(0u, 1u, ${a}.x == 0u), 0u)`;
        case "to_nat":
        case "from_nat":
          return `vec2u(${a}.x, 0u)`;
      }
    }
    if (type === "Nat") {
      switch (op) {
        case "add":
          return `nat_add(${a}, ${b})`;
        case "sub":
          return `nat_sub(${a}, ${b})`;
        case "pred":
          return `nat_sub(${a}, vec2u(1u, 0u))`;
        case "succ":
          return `nat_add(${a}, vec2u(1u, 0u))`;
        case "is_lt":
          return `vec2u(select(0u, 1u, word_lt(${a}, ${b})), 0u)`;
      }
    }
    throw new Error(`unimplemented IR primitive: ${name}`);
  }
  function callee(call: Call) {
    const fn = functions.get(call.name);
    if (!fn) throw new Error(`undefined IR function: ${call.name}`);
    return fn;
  }
  function emitInstruction(instruction: Instruction): string {
    switch (instruction.op) {
      case "text":
        return `set_reg(base, ${instruction.dst}u, text_literal(${instruction.text}u)); ${pc(instruction.next)}`;
      case "constant":
        return `set_reg(base, ${instruction.dst}u, vec2u(${instruction.value[0]}u, ${instruction.value[1]}u)); ${pc(instruction.next)}`;
      case "primitive":
        return `set_reg(base, ${instruction.dst}u, ${primitive(instruction.name, instruction.args)}); ${pc(instruction.next)}`;
      case "construct":
        return `
        let slot = allocate_node(${instruction.tag}u, ${instruction.fields.length}u);
        if (slot == 0xffffffffu) { return; }
        ${instruction.fields.map((reg, i) => `heap[slot].fields[${i}u] = ${r(reg)}; retain(${r(reg)});`).join("\n")}
        set_reg(base, ${instruction.dst}u, vec2u(slot, 0x80000000u)); ${pc(instruction.next)}`;
      case "match":
        return `
        let value = ${r(instruction.value)};
        if (!is_node(value) || value.x >= params.heap_capacity) { fail(32u); return; }
        switch (heap[value.x].tag) {
          ${instruction.arms
            .map(
              (arm) => `case ${arm.tag}u: {
            ${arm.fields.map((dst, i) => `set_reg(base, ${dst}u, heap[value.x].fields[${i}u]);`).join("\n")}
            ${pc(arm.next)}
          }`,
            )
            .join("\n")}
          default: { ${instruction.fallback === undefined ? "fail(32u); return;" : pc(instruction.fallback)} }
        }`;
      case "branch":
        return `if (all(${r(instruction.value)} == vec2u(0u))) { ${pc(instruction.zero)} } else { ${pc(instruction.nonzero)} }`;
      case "effect":
        return `
        if (id != 0u) { fail(64u); return; }
        let slot = allocate_node(${ir.effects[instruction.effect].tag}u, ${instruction.args.length}u);
        if (slot == 0xffffffffu) { return; }
        ${instruction.args.map((reg, i) => `heap[slot].fields[${i}u] = ${r(reg)}; retain(${r(reg)});`).join("\n")}
        let request = vec2u(slot, 0x80000000u);
        retain(request);
        tasks[id].result = request;
        tasks[id].padding = vec2u(${instruction.dst}u, tasks[id].sp);
        ${pc(instruction.next)}
        atomicStore(&tasks[id].state, 4u);
        return;`;
      case "return":
        return `
        let result = ${r(instruction.value)};
        if (tasks[id].sp == 0u) {
          retain(result);
          tasks[id].result = result;
          clear_frame(base);
          atomicStore(&tasks[id].state, DONE);
          if (id == 0u) { atomicStore(&control.done, 1u); }
          return;
        }
        let destination = frames[base].destination;
        tasks[id].sp -= 1u;
        set_reg(base - 1u, destination, result);
        clear_frame(base);`;
      case "call": {
        const { call, tail } = instruction;
        const fn = callee(call);
        return `
          ${call.args.map((arg, i) => `let arg${i} = ${r(arg)}; retain(arg${i});`).join("\n")}
          ${
            tail
              ? "let callee_frame = base; clear_frame(base);"
              : `
            if (tasks[id].sp + 1u >= params.stack) { fail(2u); return; }
            ${pc(instruction.next)}
            tasks[id].sp += 1u;
            let callee_frame = base + 1u;
            frames[callee_frame].destination = ${call.dst}u;`
          }
          frames[callee_frame].pc = ${fn.entry}u;
          ${call.args.map((_, i) => `set_reg(callee_frame, ${i}u, arg${i}); release(arg${i});`).join("\n")}`;
      }
      case "invoke":
        return `let closure = ${r(instruction.closure)};
          if (!is_node(closure) || closure.x >= params.heap_capacity) { fail(32u); return; }
          switch (heap[closure.x].tag) {
          ${ir.closures
            .map((c) => {
              const fn = functions.get(c.function)!;
              const count = fn.params.length - 1;
              const values = [
                ...Array.from(
                  { length: count },
                  (_, j) => `heap[closure.x].fields[${j}u]`,
                ),
                r(instruction.argument),
              ];
              return `case ${c.tag}u: {
              ${values.map((v, j) => `let arg${j} = ${v}; retain(arg${j});`).join("\n")}
              ${instruction.tail ? "let callee_frame = base; clear_frame(base);" : `if (tasks[id].sp + 1u >= params.stack) { fail(2u); return; } ${pc(instruction.next)} tasks[id].sp += 1u; let callee_frame = base + 1u; frames[callee_frame].destination = ${instruction.dst}u;`}
              frames[callee_frame].pc = ${fn.entry}u;
              ${values.map((_, j) => `set_reg(callee_frame, ${j}u, arg${j}); release(arg${j});`).join("\n")}
            }`;
            })
            .join("\n")}
          default: { fail(32u); return; }
          }`;
      case "fork":
        return `
        if (tasks[id].depth >= params.parallel_depth) { ${pc(instruction.sequential)} }
        else {
          let first = atomicAdd(&control.task_cursor, ${instruction.calls.length}u);
          if (first > params.task_free || ${instruction.calls.length}u > params.task_free - first) {
            if (params.capacity <= ${instruction.calls.length}u) { fail(1u); return; }
            ${pc(instruction.sequential)}
            continue;
          }
          atomicAdd(&control.created, ${instruction.calls.length}u);
          ${instruction.calls
            .map(
              (call, j) => `{
            let child = queues[params.capacity + first + ${j}u];
            tasks[child].depth = tasks[id].depth + 1u;
            tasks[child].sp = 0u;
            frames[child * params.stack].pc = ${callee(call).entry}u;
            ${call.args.map((arg, i) => `set_reg(child * params.stack, ${i}u, ${r(arg)});`).join("\n")}
            tasks[id].children[${j}u] = vec2u(child, ${call.dst}u);
            atomicStore(&tasks[child].state, READY);
          }`,
            )
            .join("\n")}
          tasks[id].joins = ${instruction.calls.length}u;
          ${pc(instruction.next)}
          atomicStore(&tasks[id].state, WAITING);
          return;
        }`;
    }
  }
  const cases = ir.instructions
    .map((instruction, i) => `case ${i}u: { ${emitInstruction(instruction)} }`)
    .join("\n");
  return {
    registers,
    maxFork,
    maxFields,
    shader: template
      .replaceAll("__REGISTERS__", String(registers))
      .replaceAll("__MAX_FORK__", String(maxFork))
      .replaceAll("__MAX_FIELDS__", String(maxFields))
      .replace("__TEXT__", emitText(ir))
      .replace("__CASES__", cases),
  };
}
