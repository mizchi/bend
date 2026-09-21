import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { create, globals } from "webgpu";
import { runHybrid } from "../../bend2/webgpu/hybrid.mjs";
Object.assign(globalThis, globals);
const root = resolve(import.meta.dirname, "../..");

test("hybrid CPU execution uses upstream C and resumes two GPU results", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bend upstream host "));
  try {
    const source = join(dir, "main.bend"),
      artifact = join(dir, "program.json"),
      wasm = join(dir, "host.wasm");
    await writeFile(
      source,
      `import Base
def bump(x: U32) -> U32:
  U32.inc(x)
def main() -> IO(Unit):
  do IO<Unit>:
    IO.print(U32.show(bump!(40)))
    IO.print(U32.show(bump!(41)))
`,
    );
    execFileSync("bun", [
      join(root, "tools/webgpu/build-webgpu.ts"),
      source,
      artifact,
    ]);
    execFileSync("bun", [
      join(root, "tools/webgpu/build-hybrid.ts"),
      artifact,
      wasm,
    ]);
    const c = await readFile(join(dir, "host.c"), "utf8");
    assert.match(
      c,
      /static Reply work_loop\(/,
      "the upstream C evaluator must be present",
    );
    assert.doesNotMatch(
      c,
      /static Frame frames\[/,
      "the private CPU VM must be absent",
    );
    const program = JSON.parse(await readFile(artifact));
    const result = await runHybrid(program, await readFile(wasm), {
      gpu: create([]),
    });
    assert.deepEqual(result.stdout, ["41", "42"]);
    assert.equal(result.stats.gpuCalls, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("native packed arrays cross GPU seams in both directions", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bend native arrays "));
  try {
    const source = join(dir, "main.bend"),
      artifact = join(dir, "program.json"),
      wasm = join(dir, "host.wasm");
    await writeFile(
      source,
      `import Base

def bump(a: Array<U32>) -> Array<U32>:
  Array.map(U32, U32, U32.inc, a)
def pick(r: Array<U32> & U32) -> U32:
  (a, x) = r
  x
type Cell is Data:
  Cell{left: U32, right: Nat}
def cells(a: Array<Cell>) -> Array<Cell>:
  a
def pick_cell(r: Array<Cell> & Cell) -> Nat:
  (a, x) = r
  match x:
    case Cell{left, right}: right
def nats(a: Array<Nat>) -> Array<Nat>:
  a
def pick_nat(r: Array<Nat> & Nat) -> Nat:
  (a, x) = r
  x
def main() -> IO(Unit):
  do IO<Unit>:
    IO.print(U32.show(pick(Array.get(U32, bump!(Array.new(U32, 3n, 40)), 7))))
    IO.print(Nat.show(pick_nat(Array.get(Nat, nats!(Array.new(Nat, 2n, Nat.mul(1048576n, 1048576n))), 3))))
    IO.print(Nat.show(pick_cell(Array.get(Cell, cells!(Array.new(Cell, 2n, Cell{40, Nat.add(Nat.mul(1048576n, 1048576n), 1n)})), 3))))
`,
    );
    execFileSync("bun", [
      join(root, "tools/webgpu/build-webgpu.ts"),
      source,
      artifact,
    ]);
    execFileSync("bun", [
      join(root, "tools/webgpu/build-hybrid.ts"),
      artifact,
      wasm,
    ]);
    const result = await runHybrid(
      JSON.parse(await readFile(artifact)),
      await readFile(wasm),
      { gpu: create([]) },
    );
    assert.deepEqual(result.stdout, ["41", "1099511627776", "1099511627777"]);
    assert.equal(result.stats.gpuCalls, 3);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("native CPU loops yield to cancellation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bend native yield "));
  try {
    const source = join(dir, "main.bend"),
      artifact = join(dir, "program.json"),
      wasm = join(dir, "host.wasm");
    await writeFile(
      source,
      `import Base

def spin(n: Nat, x: U32) -> U32:
  match n:
    case 0n: x
    case 1n+p: spin(p, U32.xor(U32.mul(x, 1664525), 1013904223))
def main() -> U32:
  spin(4294967295n, 1)
`,
    );
    execFileSync("bun", [
      join(root, "tools/webgpu/build-webgpu.ts"),
      source,
      artifact,
    ]);
    execFileSync("bun", [
      join(root, "tools/webgpu/build-hybrid.ts"),
      artifact,
      wasm,
    ]);
    // A separate process makes a synchronous Wasm hang a bounded test failure.
    execFileSync(
      "node",
      [
        "--input-type=module",
        "-e",
        `
      import {readFileSync} from 'node:fs';
      import assert from 'node:assert/strict';
      import {runHybrid} from ${JSON.stringify(join(root, "bend2/webgpu/hybrid.mjs"))};
      const signal = AbortSignal.timeout(100);
      await assert.rejects(runHybrid(JSON.parse(readFileSync(process.argv[1])),readFileSync(process.argv[2]),{signal,hostBudget:8}),{name:'TimeoutError'});
    `,
        artifact,
        wasm,
      ],
      { timeout: 5000 },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("long IO strings cross the native boundary without JavaScript recursion", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bend native text "));
  try {
    const source = join(dir, "main.bend"),
      artifact = join(dir, "program.json"),
      wasm = join(dir, "host.wasm");
    await writeFile(
      source,
      `import Base

def show(r: Result<&1, &1, U32 & String, String>) -> IO(Unit):
  match r:
    case Fail{error}: IO.print("failed")
    case Done{value}: IO.print(value)
def main() -> IO(Unit):
  do IO<Unit>:
    r : Result<&1, &1, U32 & String, String> <- IO.get_env("LONG")
    show(r)
`,
    );
    execFileSync("bun", [
      join(root, "tools/webgpu/build-webgpu.ts"),
      source,
      artifact,
    ]);
    execFileSync("bun", [
      join(root, "tools/webgpu/build-hybrid.ts"),
      artifact,
      wasm,
    ]);
    const value = "日本語🙂".repeat(3000);
    const result = await runHybrid(
      JSON.parse(await readFile(artifact)),
      await readFile(wasm),
      { io: { env: { LONG: value } } },
    );
    assert.deepEqual(result.stdout, [value]);
    assert.equal(result.stats.gpuCalls, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
