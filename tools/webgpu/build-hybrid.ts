import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import type { Artifact } from "../../bend2/webgpu/ir.ts";
const root = resolve(import.meta.dirname, "../..");
async function main() {
  const [input, output, ...extra] = process.argv.slice(2);
  if (!input || !output || extra.length || !output.endsWith(".wasm"))
    throw new Error(
      "usage: bun tools/webgpu/build-hybrid.ts program.json host.wasm",
    );
  const program: Artifact = JSON.parse(await readFile(input, "utf8"));
  if (program.abi !== "bend-webgpu-v4" || !program.host)
    throw new Error("rebuild the WebGPU artifact with upstream host metadata");
  const target = resolve(output),
    c = target.slice(0, -5) + ".c";
  await mkdir(dirname(target), { recursive: true });
  const digest = createHash("sha256")
    .update(JSON.stringify(program.ir))
    .digest();
  const bridge = (
    await readFile(resolve(root, "bend2/webgpu/upstream-host.c"), "utf8")
  )
    .replace("__FINGERPRINT__", [...digest].join(","))
    .replace(
      "__METADATA__",
      JSON.stringify(JSON.stringify(program.host.metadata)),
    );
  await writeFile(
    c,
    "#define BEND_ASYNC_HOST 1\n#define main bend_native_main\n" +
      program.host.source +
      "\n#undef main\n" +
      bridge,
  );
  const emcc =
    process.env.EMCC || resolve(root, "build/emsdk/upstream/emscripten/emcc");
  const result = spawnSync(
    emcc,
    [
      c,
      "-std=c11",
      "-O2",
      "-mtail-call",
      "--no-entry",
      "-sSTANDALONE_WASM=1",
      "-sFILESYSTEM=0",
      "-sINITIAL_MEMORY=100663296",
      "-sSTACK_SIZE=1048576",
      "-o",
      target,
    ],
    { stdio: "inherit" },
  );
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error("upstream Wasm host compilation failed");
  console.log(target);
}
main().catch((error) => {
  console.error(`build-hybrid: ${error.message}`);
  process.exitCode = 1;
});
