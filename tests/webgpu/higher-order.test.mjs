import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { create, globals } from "webgpu";
import { runProgram } from "../../bend2/webgpu/runtime.mjs";
import { runHybrid } from "../../bend2/webgpu/hybrid.mjs";
Object.assign(globalThis, globals);
const root = resolve(import.meta.dirname, "../..");

test("higher-order functions, captures, partial application and Array.map execute in WGSL and Wasm", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bend closures "));
  try {
    const artifact = join(dir, "program.json"),
      wasm = join(dir, "host.wasm");
    execFileSync("bun", [
      join(root, "tools/webgpu/build-webgpu.ts"),
      join(root, "demos/webgpu/higher-order.bend"),
      artifact,
    ]);
    execFileSync("bun", [
      join(root, "tools/webgpu/build-hybrid.ts"),
      artifact,
      wasm,
    ]);
    const program = JSON.parse(await readFile(artifact));
    const gpu = create([]);
    assert.deepEqual((await runProgram(program, { gpu })).stdout, [
      "42",
      "42",
      "42",
      "42",
    ]);
    const hybrid = await runHybrid(program, await readFile(wasm), { gpu });
    assert.deepEqual(hybrid.stdout, ["42", "42", "42", "42"]);
    assert.equal(hybrid.stats.gpuCalls, 3);
    assert.ok(hybrid.stats.uploadedNodes >= 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
