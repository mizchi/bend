import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const [file, ...args] = process.argv.slice(2);
if (!file) {
  console.error("usage: node tools/webgpu/run-wasm.mjs build/program.mjs [program arguments]");
  process.exit(1);
}
const { default: createProgram } = await import(pathToFileURL(resolve(file)).href);
const program = await createProgram({
  print: (line) => console.log(line),
  printErr: (line) => console.error(line),
});
process.exitCode = program.callMain(["--", ...args]);
