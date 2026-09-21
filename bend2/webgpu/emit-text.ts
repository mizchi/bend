import { readFileSync } from "node:fs";
import type { ProgramIR } from "./ir.ts";

/** Text is a producer optimization, never an alternative value representation. */
export function emitText(ir: ProgramIR): string {
  if (
    !ir.instructions.some(
      (i) =>
        i.op === "text" || (i.op === "primitive" && i.name.endsWith(".show")),
    )
  )
    return "";
  let source = readFileSync(new URL("text.wgsl", import.meta.url), "utf8");
  for (const [key, name] of [
    ["SNIL", "SNil"],
    ["SCON", "SCon"],
    ["CHR", "Chr"],
  ]) {
    const tag = ir.constructors.find((c) => c.name === name)?.tag;
    if (tag === undefined)
      throw new Error(`missing String constructor ${name}`);
    source = source.replaceAll(`__${key}__`, String(tag));
  }
  return source.replace(
    "__TEXT_CASES__",
    ir.strings
      .map((text, id) => {
        const codes = Array.from(text, (c) => c.codePointAt(0)!);
        if (!codes.length)
          return `case ${id}u: { }`;
        const values = codes.map((c) => `${c}u`).join(",");
        return `case ${id}u: {
      let codes = array<u32, ${codes.length}>(${values});
      for (var i = ${codes.length}u; i > 0u; i--) {
        tail = text_cons(codes[i - 1u], tail);
        if (atomicLoad(&control.error) != 0u) { return vec2u(0u); }
      }
    }`;
      })
      .join("\n"),
  );
}
