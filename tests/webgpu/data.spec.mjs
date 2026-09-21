import { test, expect } from "@playwright/test";
import { readFile, mkdtemp, writeFile, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
const root = resolve(import.meta.dirname, "../..");
async function check(page, source, expected, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), "bend data "));
  try {
    const input = join(dir, "input.bend"),
      output = join(dir, "program.json");
    await writeFile(input, source);
    execFileSync("bun", [join(root, "tools/webgpu/build-webgpu.ts"), input, output]);
    const program = JSON.parse(await readFile(output, "utf8"));
    const wasm = join(dir, "reference.mjs");
    execFileSync("python3", [join(root, "tools/webgpu/build-wasm.py"), input, wasm]);
    const reference = execFileSync(
      "node",
      [join(root, "tools/webgpu/run-wasm.mjs"), wasm],
      { encoding: "utf8" },
    )
      .trim()
      .split("\n");
    expect(reference).toEqual(expected);
    await page.goto("/");
    const result = await page.evaluate(
      async ({ program, options }) => {
        const { runProgram } = await import("/backend/runtime.mjs");
        return runProgram(program, options);
      },
      { program, options },
    );
    expect(result.stdout).toEqual(expected);
    return result;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
test("shared ADTs survive parallel consumption", async ({ page }) => {
  const source = await readFile(
    join(root, "tests/webgpu/fixtures/s07_share_tree.bend"),
    "utf8",
  );
  const result = await check(page, source, ["14"]);
  expect(result.stats.heapAllocated).toBeGreaterThan(0);
});
test("Base Array get, set, clone and wrapped indexing", async ({ page }) => {
  await check(
    page,
    await readFile(join(root, "tests/webgpu/fixtures/s05_array_get.bend"), "utf8"),
    ["7"],
  );
  await check(
    page,
    `import Base
def take(r: Array<U32> & U32) -> U32:
  (a, v) = r
  v
def both(r: Array<U32> & Array<U32>) -> U32:
  (a, b) = r
  U32.add(take(Array.get(U32, a, 2)), take(Array.get(U32, b, 3)))
def main() -> IO(Unit):
  IO.print(U32.show(both(Array.clone(U32, Array.set(U32, Array.new(U32, 3n, 7), 10, 99)))))
`,
    ["106"],
  );
});
test("FWHT data pipeline matches the existing Wasm implementation", async ({
  page,
}) => {
  test.setTimeout(120000);
  const source = await readFile(join(root, "tests/webgpu/fixtures/fwht_check.bend"), "utf8");
  // Keep the computation functions unchanged; isolate each scalar root.
  for (const depth of [1, 2, 5, 8, 10]) {
    await check(
      page,
      source.slice(0, source.indexOf("def main()")) +
        `def main() -> IO(Unit):\n  IO.print(Bool.show(U32.is_eq(lhs(${depth}n), rhs(${depth}n))))\n`,
      ["True"],
      { taskCapacity: 128 },
    );
  }
});
test("heap and task slots are reclaimed across repeated recursive work", async ({
  page,
}) => {
  const source = `import Base
type Box is Data:
  Box{v: U32}
def unbox(b: Box) -> U32:
  match b:
    case Box{v}:
      v
def loop(+n: Nat, +x: U32) -> U32:
  match n:
    case 0n:
      x
    case 1n+p:
      a b = unbox(Box{x}) unbox(Box{1})
      loop(p, U32.add(a, b))
def main() -> U32:
  loop(100n, 0)
`;
  const result = await check(page, source, ["100"], {
    taskCapacity: 4,
    heapCapacity: 8,
    instructionBudget: 8,
  });
  expect(result.stats.tasks).toBe(201);
  expect(result.stats.heapReclaimed).toBeGreaterThan(100);
});

test("the original FWHT program runs multiple IO statements unchanged", async ({
  page,
}) => {
  test.setTimeout(120000);
  await check(
    page,
    await readFile(join(root, "tests/webgpu/fixtures/fwht_check.bend"), "utf8"),
    [
      "d=1  involution: True",
      "d=2  involution: True",
      "d=5  involution: True",
      "d=10 involution: True",
    ],
    { taskCapacity: 128 },
  );
});

test("heap exhaustion is explicit and a new run starts with clean state", async ({
  page,
}) => {
  const source = await readFile(
    join(root, "tests/webgpu/fixtures/s07_share_tree.bend"),
    "utf8",
  );
  await expect(
    check(page, source, ["14"], { heapCapacity: 1 }),
  ).rejects.toThrow("heap capacity exhausted");
  await check(page, source, ["14"]);
});
