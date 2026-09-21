// A separate, deliberately strict compatibility gate. Known gaps stay red;
// neither expected failures nor backend-specific output is accepted as success.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { cases } from "./compat-cases.mjs";
const root = resolve(import.meta.dirname, "../..");
for (const name of cases) {
  test(`${name}: generated backends preserve upstream semantics`, () => {
    const dir = mkdtempSync(join(tmpdir(), "bend compatibility "));
    const source = join(root, name);
    const artifact = join(dir, "program.json"),
      wasm = join(dir, "host.wasm"),
      reference = join(dir, "reference");
    const run = (command, args) => {
      const result = spawnSync(command, args, {
        cwd: root,
        encoding: "utf8",
        timeout: 30000,
      });
      if (result.error) throw result.error;
      return result;
    };
    const build = (command, args) => {
      const result = run(command, args);
      assert.equal(result.status, 0, result.stderr);
    };
    try {
      build("./tools/webgpu/bend.sh", [source, "-o", reference]);
      build("just", ["build-webgpu", source, artifact]);
      build("just", ["build-hybrid", artifact, wasm]);
      const expected =
        readFileSync(source, "utf8")
          .split("\n")
          .filter((line) => line.startsWith("#|"))
          .map((line) => line.slice(2))
          .join("\n") + "\n";
      const oracle = run(reference, ["--threads", "1", "--gpu", "off"]);
      assert.equal(oracle.status, 0, oracle.stderr);
      assert.equal(oracle.stdout, expected);
      const results = [
        ["WebGPU", run("node", ["tools/webgpu/run-webgpu.mjs", artifact])],
        ["hybrid", run("node", ["tools/webgpu/run-hybrid.mjs", artifact, wasm])],
      ];
      // Native pure Nat display includes 'n'; this backend's documented CLI
      // format omits that suffix. Normalize only that display convention.
      const program = JSON.parse(readFileSync(artifact, "utf8"));
      const normalized = (text) =>
        !program.ir.print && program.ir.output === "Nat"
          ? text.replace(/^(\d+)n\n$/, "$1\n")
          : text;
      const failures = results.filter(
        ([, r]) =>
          r.status !== 0 || normalized(r.stdout) !== normalized(expected),
      );
      assert.deepEqual(
        failures.map(
          ([backend, r]) =>
            `${backend}: exit=${r.status}; stdout=${r.stdout.trim()}; stderr=${r.stderr.trim()}`,
        ),
        [],
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
