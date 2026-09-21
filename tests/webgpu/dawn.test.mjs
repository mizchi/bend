import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "../..");
test("Dawn executes the generated tree program through the shared runtime", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bend dawn "));
  try {
    const artifact = join(dir, "program.json");
    execFileSync("bun", [
      join(root, "tools/webgpu/build-webgpu.ts"),
      join(root, "tests/webgpu/fixtures/s10_gpu.bend"),
      artifact,
    ]);
    const output = execFileSync(
      "node",
      [join(root, "tools/webgpu/run-webgpu.mjs"), artifact, "--json"],
      { cwd: dir, encoding: "utf8", timeout: 60_000 },
    );
    const result = JSON.parse(output);
    assert.deepEqual(result.stdout, ["4294443008"]);
    assert.equal(result.stats.tasks, 511);
    assert.ok(result.stats.rounds > 1);
    assert.equal(JSON.parse(await readFile(artifact)).abi, "bend-webgpu-v4");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Dawn and Wasm exchange shared data through the hybrid CLI", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bend hybrid dawn "));
  try {
    const artifact = join(dir, "program.json"),
      wasm = join(dir, "host.wasm");
    execFileSync("bun", [
      join(root, "tools/webgpu/build-webgpu.ts"),
      join(root, "demos/webgpu/hybrid.bend"),
      artifact,
    ]);
    execFileSync("bun", [
      join(root, "tools/webgpu/build-hybrid.ts"),
      artifact,
      wasm,
    ]);
    const result = JSON.parse(
      execFileSync(
        "node",
        [join(root, "tools/webgpu/run-hybrid.mjs"), artifact, wasm, "--json"],
        { cwd: dir, encoding: "utf8", timeout: 60000 },
      ),
    );
    assert.deepEqual(result.stdout, ["開始", "GPU tree ready", "352", "176"]);
    assert.equal(result.stats.gpuCalls, 2);
    assert.equal(result.stats.uploadedNodes, 63);
    assert.equal(result.stats.downloadedNodes, 63);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("explicit bang on scalar and text intrinsics still crosses the GPU boundary", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bend intrinsic dawn "));
  try {
    const input = join(dir, "input.bend"),
      artifact = join(dir, "program.json"),
      wasm = join(dir, "host.wasm");
    const { writeFile } = await import("node:fs/promises");
    await writeFile(
      input,
      "import Base\ndef main() -> IO(Unit):\n  do IO<Unit>:\n    IO.print(U32.show!(U32.add!(40, 2)))\n    IO.print(Nat.show!(Nat.add!(4294967295n, 2n)))\n",
    );
    execFileSync("bun", [
      join(root, "tools/webgpu/build-webgpu.ts"),
      input,
      artifact,
    ]);
    execFileSync("bun", [
      join(root, "tools/webgpu/build-hybrid.ts"),
      artifact,
      wasm,
    ]);
    const result = JSON.parse(
      execFileSync(
        "node",
        [join(root, "tools/webgpu/run-hybrid.mjs"), artifact, wasm, "--json"],
        { encoding: "utf8", timeout: 60000 },
      ),
    );
    assert.deepEqual(result.stdout, ["42", "4294967297"]);
    assert.equal(result.stats.gpuCalls, 4);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
