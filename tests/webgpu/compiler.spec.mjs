import { test, expect } from "@playwright/test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "../..");
const env = { ...process.env, BEND_NO_TELEMETRY: "1" };

async function compile(source, run) {
  const dir = await mkdtemp(join(tmpdir(), "bend webgpu "));
  try {
    const input = join(dir, "input file.bend");
    const output = join(dir, "program.json");
    await writeFile(input, source);
    execFileSync(
      "bun",
      [join(root, "tools/webgpu/build-webgpu.ts"), input, output],
      { cwd: dir, env },
    );
    return await run(JSON.parse(await readFile(output, "utf8")), input, dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function execute(page, program, options = {}) {
  await page.goto("/");
  return page.evaluate(
    async ({ program, options }) => {
      const { runProgram } = await import("/backend/runtime.mjs");
      return runProgram(program, options);
    },
    { program, options },
  );
}

test("Bend source compiles to WGSL and matches Wasm at multiple recursion depths", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const original = await readFile(
    join(root, "tests/webgpu/fixtures/s10_gpu.bend"),
    "utf8",
  );
  for (const depth of [0, 1, 5, 10, 20]) {
    await compile(
      original.replace("20n", `${depth}n`),
      async (program, input, dir) => {
        const wasm = join(dir, "reference.mjs");
        execFileSync(
          "python3",
          [join(root, "tools/webgpu/build-wasm.py"), input, wasm],
          { env },
        );
        const reference = execFileSync(
          "node",
          [join(root, "tools/webgpu/run-wasm.mjs"), wasm],
          { env, encoding: "utf8" },
        ).trim();
        const result = await execute(page, program);
        expect(result.stdout).toEqual([reference]);
        expect(Number(result.stdout[0])).toBe(
          Number(
            ((BigInt(2 ** depth) * BigInt(2 ** depth - 1)) / 2n) & 0xffffffffn,
          ),
        );
        if (depth >= 5) expect(result.stats.tasks).toBeGreaterThan(1);
      },
    );
  }
});

test("renaming and changing the computation changes generated GPU behavior", async ({
  page,
}) => {
  const original = await readFile(
    join(root, "tests/webgpu/fixtures/s10_gpu.bend"),
    "utf8",
  );
  const source = original
    .replaceAll("tree", "different_name")
    .replace("20n", "7n")
    .replace("U32.add(a, b)", "U32.xor(a, b)")
    .replace("7n, 0", "7n, 13");
  await compile(source, async (program, input) => {
    const reference = execFileSync(join(root, "tools/webgpu/bend.sh"), [input], {
      env,
      encoding: "utf8",
    }).trim();
    const result = await execute(page, program);
    expect(result.stdout).toEqual([reference]);
    expect(result.stats.tasks).toBeGreaterThan(1);
  });
});

test("existing type errors are rejected", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bend webgpu reject "));
  try {
    for (const sample of ["s09_while"]) {
      const result = spawnSync(
        "bun",
        [
          join(root, "tools/webgpu/build-webgpu.ts"),
          join(root, `tests/webgpu/fixtures/${sample}.bend`),
          join(dir, "program.json"),
        ],
        { env, encoding: "utf8" },
      );
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(
        sample === "s09_while" ? "decreasing self-call" : "unsupported",
      );
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("scalar boundaries, tail calls, and unequal fork branches match Bend", async ({
  page,
}) => {
  const cases = [
    ["Nat", "Nat.add(4294967295n, 2n)", "4294967297"],
    ["Nat", "Nat.sub(Nat.add(4294967295n, 1n), 1n)", "4294967295"],
    ["Nat", "Nat.sub(1n, Nat.add(4294967295n, 1n))", "0"],
    ["U32", "U32.from_nat(Nat.add(4294967295n, 2n))", "1"],
    ["U32", "U32.add(4294967295, 2)", "1"],
    ["U32", "U32.shln(1, 32n)", "0"],
    ["U32", "U32.div(7, 0)", "0"],
    ["U32", "U32.mod(7, 0)", "7"],
    ["Bool", "Nat.is_lt(4294967295n, Nat.add(4294967295n, 1n))", "True"],
  ];
  for (const [type, expression, expected] of cases) {
    const source = `import Base\ndef main() -> IO(Unit):\n  IO.print(${type}.show(${expression}))\n`;
    await compile(source, async (program) => {
      expect((await execute(page, program)).stdout).toEqual([expected]);
    });
  }
  const source = `import Base
def count(+n: Nat, +acc: U32) -> U32:
  match n:
    case 0n:
      acc
    case 1n+p:
      count(p, U32.inc(acc))
def choose(b: Bool) -> U32:
  match b:
    case False{}:
      7
    case True{}:
      a b = count(70n, 1) count(3n, 2)
      U32.sub(a, b)
def main() -> U32:
  choose!(True{})
`;
  await compile(source, async (program, input) => {
    const reference = execFileSync(join(root, "tools/webgpu/bend.sh"), [input], {
      env,
      encoding: "utf8",
    }).trim();
    // A one-frame stack proves tail calls reuse the frame. Low fuel forces
    // continuation across many passes while sibling branches finish apart.
    const result = await execute(page, program, {
      stackDepth: 1,
      instructionBudget: 3,
    });
    expect(result.stdout).toEqual([reference]);
    expect(result.stdout).toEqual(["66"]);
    expect(result.stats.tasks).toBe(3);
    expect(result.stats.rounds).toBeGreaterThan(20);
  });
});

test("resource exhaustion fails explicitly and does not return a partial result", async ({
  page,
}) => {
  const original = await readFile(
    join(root, "tests/webgpu/fixtures/s10_gpu.bend"),
    "utf8",
  );
  await compile(original.replace("20n", "5n"), async (program) => {
    for (const [options, error] of [
      [{ taskCapacity: 2 }, "task capacity exhausted"],
      [{ parallelDepth: 0, stackDepth: 1 }, "evaluation stack exhausted"],
      [{ instructionBudget: 1, maxRounds: 1 }, "dispatch budget exhausted"],
      [
        { taskCapacity: 1048576, stackDepth: 1024 },
        "exceeds WebGPU device limits",
      ],
    ])
      await expect(execute(page, program, options)).rejects.toThrow(error);
    expect((await execute(page, program, { parallelDepth: 0 })).stdout).toEqual(
      ["496"],
    );
  });
  await compile(
    `import Base
def grow(+n: Nat, +x: Nat) -> Nat:
  match n:
    case 0n:
      x
    case 1n+p:
      grow(p, Nat.add(x, x))
def main() -> Nat:
  grow(48n, 1n)
`,
    async (program) => {
      await expect(execute(page, program)).rejects.toThrow(
        "Nat exceeds 2^48-1",
      );
    },
  );
});

test("missing adapters, invalid shaders, device loss, and cancellation fail", async ({
  page,
}) => {
  const source = "import Base\ndef main() -> U32:\n  42\n";
  await compile(source, async (program) => {
    await page.goto("/");
    const errors = await page.evaluate(async (program) => {
      const { runProgram } = await import("/backend/runtime.mjs");
      const errors = [];
      for (const run of [
        () =>
          runProgram(program, { gpu: { requestAdapter: async () => null } }),
        () => runProgram({ ...program, shader: "invalid shader" }),
        () => runProgram(program, { signal: AbortSignal.abort() }),
        async () => {
          const adapter = await navigator.gpu.requestAdapter();
          return runProgram(program, {
            gpu: {
              requestAdapter: async () => ({
                info: adapter.info,
                requestDevice: async () => {
                  const device = await adapter.requestDevice();
                  device.destroy();
                  return device;
                },
              }),
            },
          });
        },
      ]) {
        try {
          await run();
          errors.push("");
        } catch (error) {
          errors.push(error.message);
        }
      }
      return errors;
    }, program);
    expect(errors).toHaveLength(4);
    expect(errors[0]).toContain("No WebGPU adapter");
    for (const message of errors) expect(message.length).toBeGreaterThan(0);
  });
});
