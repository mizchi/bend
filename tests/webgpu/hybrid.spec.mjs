import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
const root = resolve(import.meta.dirname, "../..");
test("Wasm suspends for two GPU calls, transfers shared data, and resumes IO", async ({
  page,
}) => {
  test.setTimeout(120000);
  const source = await readFile(
    resolve(root, "demos/webgpu/hybrid.bend"),
    "utf8",
  );
  await writeFile(resolve(root, "build/webgpu/hybrid-input.bend"), source);
  execFileSync("bun", [
    resolve(root, "tools/webgpu/build-webgpu.ts"),
    resolve(root, "build/webgpu/hybrid-input.bend"),
    resolve(root, "build/webgpu/hybrid.json"),
  ]);
  execFileSync("python3", [
    resolve(root, "tools/webgpu/build-wasm.py"),
    resolve(root, "build/webgpu/hybrid-input.bend"),
    resolve(root, "build/webgpu/hybrid-reference.mjs"),
  ]);
  const reference = execFileSync(
    "node",
    [
      resolve(root, "tools/webgpu/run-wasm.mjs"),
      resolve(root, "build/webgpu/hybrid-reference.mjs"),
    ],
    { encoding: "utf8" },
  )
    .trim()
    .split("\n");
  execFileSync("bun", [
    resolve(root, "tools/webgpu/build-hybrid.ts"),
    resolve(root, "build/webgpu/hybrid.json"),
    resolve(root, "build/webgpu/hybrid-host.wasm"),
  ]);
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const { runHybrid } = await import("/backend/hybrid.mjs");
    const program = await (await fetch("/hybrid.json")).json();
    const wasm = await (await fetch("/hybrid-host.wasm")).arrayBuffer();
    const first = await runHybrid(program, wasm);
    const second = await runHybrid(program, wasm);
    const controller = new AbortController();
    let cancelled = false;
    try {
      await runHybrid(program, wasm, {
        signal: controller.signal,
        onPrint: () => controller.abort(),
      });
    } catch (error) {
      cancelled = error.name === "AbortError";
    }
    let mismatch = false;
    try {
      await runHybrid(
        { ...program, ir: { ...program.ir, strings: ["wrong"] } },
        wasm,
      );
    } catch (error) {
      mismatch = error.message.includes("fingerprint mismatch");
    }
    return { first, second, cancelled, mismatch };
  });
  expect(result.first.stdout).toEqual(reference);
  expect(result.first.stdout).toEqual(["開始", "GPU tree ready", "352", "176"]);
  expect(result.second.stdout).toEqual(result.first.stdout);
  expect(result.cancelled).toBe(true);
  expect(result.mismatch).toBe(true);
  expect(result.first.stats.gpuCalls).toBe(2);
  expect(result.first.stats.uploadedNodes).toBeGreaterThan(0);
  expect(result.first.stats.downloadedNodes).toBeGreaterThan(0);
});

test("the hybrid browser example displays output and load errors", async ({
  page,
}) => {
  // This test builds its own inputs so it also works when selected alone.
  execFileSync("bun", [
    resolve(root, "tools/webgpu/build-webgpu.ts"),
    resolve(root, "demos/webgpu/hybrid.bend"),
    resolve(root, "build/webgpu/hybrid.json"),
  ]);
  execFileSync("bun", [
    resolve(root, "tools/webgpu/build-hybrid.ts"),
    resolve(root, "build/webgpu/hybrid.json"),
    resolve(root, "build/webgpu/hybrid-host.wasm"),
  ]);
  await page.route("**/program.json", (route) =>
    route.continue({ url: "http://127.0.0.1:4174/hybrid.json" }),
  );
  await page.route("**/host.wasm", (route) =>
    route.continue({ url: "http://127.0.0.1:4174/hybrid-host.wasm" }),
  );
  await page.goto("/hybrid.html");
  await page
    .getByRole("button", { name: "Run Wasm + GPU", exact: true })
    .click();
  await expect(page.getByRole("status")).toHaveText("Completed");
  await expect(page.locator("#stdout")).toHaveText(
    "開始\nGPU tree ready\n352\n176\n",
  );
  await expect(page.locator("#details")).toContainText('"gpuCalls": 2');
  await page.route("**/host.wasm", (route) =>
    route.fulfill({ status: 404, body: "missing" }),
  );
  await page
    .getByRole("button", { name: "Run Wasm + GPU", exact: true })
    .click();
  await expect(page.getByRole("status")).toHaveText("Failed");
  await expect(page.locator("#details")).toContainText("404");
});
