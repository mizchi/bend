import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
const root = resolve(import.meta.dirname, "../..");
for (const name of ["higher-order", "io", "file-io"]) {
  test(`${name}: Chromium executes closures and host effects in both backends`, async ({
    page,
  }) => {
    test.setTimeout(120000);
    const source = resolve(root, `demos/webgpu/${name}.bend`);
    const artifact = resolve(root, `build/webgpu/${name}.json`),
      wasm = resolve(root, `build/webgpu/${name}.wasm`);
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
    let reference;
    if (name === "higher-order") {
      const module = resolve(root, "build/webgpu/higher-order-reference.mjs");
      execFileSync("python3", [
        resolve(root, "tools/webgpu/build-wasm.py"),
        source,
        module,
      ]);
      reference = execFileSync(
        "node",
        [resolve(root, "tools/webgpu/run-wasm.mjs"), module],
        { encoding: "utf8" },
      )
        .trim()
        .split("\n");
    }
    await page.goto("/");
    const results = await page.evaluate(async (name) => {
      const { runProgram } = await import("/backend/runtime.mjs");
      const { runHybrid } = await import("/backend/hybrid.mjs");
      const { createMemoryFiles } = await import("/backend/file-effects.mjs");
      const program = await (await fetch(`/${name}.json`)).json();
      const wasm = await (await fetch(`/${name}.wasm`)).arrayBuffer();
      const results = [];
      for (const run of [
        (options) => runProgram(program, options),
        (options) => runHybrid(program, wasm, options),
      ]) {
        const files = createMemoryFiles();
        results.push(
          await run({
            io: {
              args: ["hello", "日本語"],
              env: { BEND_TEST: "value" },
              now: () => 4294967297n,
              randomU32: () => 4294967295,
              handlers: files.handlers,
            },
          }),
        );
        files.dispose();
      }
      return results;
    }, name);
    for (const result of results) {
      expect(result.stdout).toEqual(
        name === "higher-order"
          ? reference
          : name === "file-io"
            ? ["hello 日本語"]
            : [
                "prefix:",
                "line",
                "hello",
                "日本語",
                "end",
                "value",
                "4294967297",
                "4294967295",
                "42",
              ],
      );
      expect(result.stderr).toEqual(name === "io" ? ["warning"] : []);
      expect(result.exitCode).toBe(0);
    }
  });
}
