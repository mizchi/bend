import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "../..");
for (const name of ["erased_field", "erased_indirect", "string_composition"]) {
  test(`${name}: Chromium preserves checked erasure and canonical strings`, async ({
    page,
  }) => {
    test.setTimeout(120000);
    const source = resolve(root, `demos/webgpu/compatibility/${name}.bend`);
    const artifact = resolve(root, `build/webgpu/compat-${name}.json`);
    const wasm = resolve(root, `build/webgpu/compat-${name}.wasm`);
    execFileSync("bun", [
      resolve(root, "tools/webgpu/build-webgpu.ts"),
      source,
      artifact,
    ]);
    execFileSync("bun", [
      resolve(root, "tools/webgpu/build-hybrid.ts"),
      artifact,
      wasm,
    ]);
    const expected = readFileSync(source, "utf8")
      .split("\n")
      .filter((line) => line.startsWith("#|"))
      .map((line) => line.slice(2));
    await page.goto("/");
    const results = await page.evaluate(async (name) => {
      const { runProgram } = await import("/backend/runtime.mjs");
      const { runHybrid } = await import("/backend/hybrid.mjs");
      const program = await (await fetch(`/compat-${name}.json`)).json();
      const wasm = await (await fetch(`/compat-${name}.wasm`)).arrayBuffer();
      return [await runProgram(program), await runHybrid(program, wasm)];
    }, name);
    for (const result of results) {
      expect(result.stdout).toEqual(expected);
      expect(result.stderr).toEqual([]);
      expect(result.exitCode).toBe(0);
    }
    if (name === "string_composition") {
      expect(results[1].stats.gpuCalls).toBe(3);
      // Show and reverse return real graphs across the GPU boundary.
      expect(results[1].stats.downloadedNodes).toBeGreaterThan(50);
    }
  });
}
