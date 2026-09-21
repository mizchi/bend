import { readFile } from "node:fs/promises";
import { create, globals } from "webgpu";
import { runProgram } from "../../bend2/webgpu/runtime.mjs";
import { createNodeIO } from "../../bend2/webgpu/node-io.mjs";

async function main() {
  const args = process.argv.slice(2),
    separator = args.indexOf("--");
  const [file, ...flags] = separator < 0 ? args : args.slice(0, separator);
  if (!file || flags.some((flag) => flag !== "--json") || flags.length > 1)
    throw new Error(
      "usage: node tools/webgpu/run-webgpu.mjs program.json [--json] [-- arguments...]",
    );
  const json = flags.includes("--json");
  Object.assign(globalThis, globals);
  // Keep Dawn local: a global reference keeps its event loop alive on exit.
  const gpu = create([]),
    program = JSON.parse(await readFile(file, "utf8"));
  const provider = createNodeIO({
    args: separator < 0 ? [] : args.slice(separator + 1),
    env: process.env,
  });
  try {
    const result = await runProgram(program, {
      gpu,
      io: {
        ...provider.io,
        onOutput: json
          ? undefined
          : (event) => process[event.stream].write(event.text),
      },
    });
    if (json) console.log(JSON.stringify(result, null, 2));
    else if (!program.ir.print)
      result.stdout.forEach((line) => console.log(line));
    process.exitCode = result.exitCode;
  } finally {
    await provider.dispose();
  }
}
main().catch((error) => {
  console.error(`run-webgpu: ${error.message}`);
  process.exitCode = 1;
});
