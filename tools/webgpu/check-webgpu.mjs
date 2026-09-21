import ts from "typescript";
import { resolve } from "node:path";

// Check comp.ts, the backend and its tools. The unchanged language checker has
// existing diagnostics and remains outside this experimental backend gate.
const configPath = resolve(import.meta.dirname, "../../tsconfig.webgpu.json");
const config = ts.readConfigFile(configPath, ts.sys.readFile);
const parsed = ts.parseJsonConfigFileContent(
  config.config,
  ts.sys,
  resolve(import.meta.dirname, "../.."),
);
const program = ts.createProgram(parsed.fileNames, parsed.options);
const upstream = resolve(import.meta.dirname, "../../bend2/bend.ts");
const diagnostics = [
  config.error,
  ...parsed.errors,
  ...ts.getPreEmitDiagnostics(program),
].filter((d) => d && (!d.file || resolve(d.file.fileName) !== upstream));
if (diagnostics.length) {
  console.error(
    ts.formatDiagnosticsWithColorAndContext(diagnostics, {
      getCanonicalFileName: (name) => name,
      getCurrentDirectory: ts.sys.getCurrentDirectory,
      getNewLine: () => "\n",
    }),
  );
  process.exitCode = 1;
} else
  console.log(
    "WebGPU compiler and runtime types: OK (unchanged bend.ts diagnostics excluded)",
  );
