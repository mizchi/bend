import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { create, globals } from "webgpu";
import { runProgram } from "../../bend2/webgpu/runtime.mjs";
import { runHybrid } from "../../bend2/webgpu/hybrid.mjs";
Object.assign(globalThis, globals);
const root = resolve(import.meta.dirname, "../..");

test("first-class IO actions suspend and resume with typed host results", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bend effects "));
  try {
    const artifact = join(dir, "program.json"),
      wasm = join(dir, "host.wasm");
    execFileSync("bun", [
      join(root, "tools/webgpu/build-webgpu.ts"),
      join(root, "demos/webgpu/io.bend"),
      artifact,
    ]);
    execFileSync("bun", [
      join(root, "tools/webgpu/build-hybrid.ts"),
      artifact,
      wasm,
    ]);
    const program = JSON.parse(await readFile(artifact)),
      bytes = await readFile(wasm),
      gpu = create([]);
    for (const run of [
      (options) => runProgram(program, options),
      (options) => runHybrid(program, bytes, options),
    ]) {
      const chunks = [];
      const result = await run({
        gpu,
        io: {
          args: ["hello", "日本語"],
          env: { BEND_TEST: "value" },
          now: () => 4294967297n,
          randomU32: () => 4294967295,
          onOutput: (event) => chunks.push(event),
        },
      });
      assert.deepEqual(result.stdout, [
        "prefix:",
        "line",
        "hello",
        "日本語",
        "end",
        "value",
        "4294967297",
        "4294967295",
        "42",
      ]);
      assert.deepEqual(result.stderr, ["warning"]);
      assert.equal(result.exitCode, 0);
      assert.deepEqual(chunks.slice(0, 3), [
        { stream: "stdout", text: "prefix:" },
        { stream: "stdout", text: "line\n" },
        { stream: "stderr", text: "warning\n" },
      ]);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("File effects round trip through browser storage and native Node storage", async () => {
  const { createMemoryFiles } = await import("../../bend2/webgpu/file-effects.mjs");
  const { createNodeIO } = await import("../../bend2/webgpu/node-io.mjs");
  const dir = await mkdtemp(join(tmpdir(), "bend files "));
  try {
    const artifact = join(dir, "program.json"),
      wasm = join(dir, "host.wasm");
    const input = join(dir, "input.bend");
    await writeFile(
      input,
      (
        await readFile(join(root, "demos/webgpu/file-io.bend"), "utf8")
      ).replaceAll("message.txt", join(dir, "message.txt")),
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
    const program = JSON.parse(await readFile(artifact)),
      bytes = await readFile(wasm),
      gpu = create([]);
    const memory = createMemoryFiles();
    assert.deepEqual(
      (await runProgram(program, { gpu, io: { handlers: memory.handlers } }))
        .stdout,
      ["hello 日本語"],
    );
    assert.equal(
      new TextDecoder().decode(memory.files.get(join(dir, "message.txt"))),
      "hello 日本語",
    );
    const native = createNodeIO();
    try {
      assert.deepEqual(
        (await runHybrid(program, bytes, { gpu, io: native.io })).stdout,
        ["hello 日本語"],
      );
    } finally {
      await native.dispose();
    }
    assert.equal(
      await readFile(join(dir, "message.txt"), "utf8"),
      "hello 日本語",
    );
    await assert.rejects(
      runHybrid(program, bytes, { gpu }),
      /Host IO capability unavailable: File.open/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("IO.die stops continuations and sleeping actions can be cancelled", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bend io control "));
  try {
    const gpu = create([]);
    for (const [name, action] of [
      ["die", 'IO.die(Unit, 7, "stopped")'],
      ["sleep", 'IO.print("sleeping")\n    IO.sleep(4294967295)'],
    ]) {
      const input = join(dir, `${name}.bend`),
        artifact = join(dir, `${name}.json`),
        wasm = join(dir, `${name}.wasm`);
      await writeFile(
        input,
        `import Base\ndef main() -> IO(Unit):\n  do IO<Unit>:\n    ${action}\n    IO.print("unreachable")\n`,
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
      const program = JSON.parse(await readFile(artifact)),
        bytes = await readFile(wasm);
      for (const run of [
        (options) => runProgram(program, options),
        (options) => runHybrid(program, bytes, options),
      ]) {
        if (name === "die") {
          const result = await run({ gpu });
          assert.equal(result.exitCode, 7);
          assert.deepEqual(result.stderr, ["stopped"]);
          assert.deepEqual(result.stdout, []);
        } else {
          const controller = new AbortController();
          let timer = setTimeout(() => controller.abort(), 5000);
          let started = false;
          try {
            await assert.rejects(
              run({
                gpu,
                signal: controller.signal,
                onPrint: () => {
                  started = true;
                  clearTimeout(timer);
                  timer = setTimeout(() => controller.abort(), 50);
                },
              }),
              { name: "AbortError" },
            );
            assert.equal(started, true);
          } finally {
            clearTimeout(timer);
          }
        }
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("custom effect handlers return typed results; missing capabilities fail explicitly", async () => {
  const { data, done, fail } = await import("../../bend2/webgpu/effects.mjs");
  const dir = await mkdtemp(join(tmpdir(), "bend custom effect "));
  try {
    const input = join(dir, "input.bend"),
      artifact = join(dir, "program.json"),
      wasm = join(dir, "host.wasm");
    await writeFile(
      input,
      `import Base

def connected(result: Result<&1, &1, U32 & String, Socket>) -> IO(Unit):
  match result:
    case Done{socket}:
      do IO<Unit>:
        Socket.close(socket)
        IO.print("connected")
    case Fail{error}:
      IO.print("failed")

def main() -> IO(Unit):
  do IO<Unit>:
    result : Result<&1, &1, U32 & String, Socket> <- TCP.connect("test.invalid", 1234)
    connected(result)
`,
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
    const program = JSON.parse(await readFile(artifact)),
      bytes = await readFile(wasm),
      gpu = create([]);
    for (const run of [
      (options) => runProgram(program, options),
      (options) => runHybrid(program, bytes, options),
    ]) {
      await assert.rejects(
        run({ gpu }),
        /Host IO capability unavailable: TCP.connect/,
      );
      let called = 0;
      const result = await run({
        gpu,
        io: {
          handlers: {
            "TCP.connect": async (args, ctx) => {
              assert.equal(ctx.text(args[0]), "test.invalid");
              assert.equal(ctx.number(args[1]), 1234n);
              called++;
              return fail(111, "not connected");
            },
          },
        },
      });
      assert.equal(called, 1);
      assert.deepEqual(result.stdout, ["failed"]);
      let closed = false;
      const success = await run({
        gpu,
        io: {
          handlers: {
            "TCP.connect": async () => done(42),
            "Socket.close": async ([socket], ctx) => {
              assert.equal(ctx.number(socket), 42n);
              closed = true;
              return data("Unit");
            },
          },
        },
      });
      assert.deepEqual(success.stdout, ["connected"]);
      assert.equal(closed, true);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("CLI preserves IO.write bytes, stderr, arguments and exit code", async () => {
  const { spawnSync } = await import("node:child_process");
  const dir = await mkdtemp(join(tmpdir(), "bend io cli "));
  try {
    const input = join(dir, "input.bend"),
      artifact = join(dir, "program.json"),
      wasm = join(dir, "host.wasm");
    await writeFile(
      input,
      `import Base

def first(xs: List<String>) -> IO(Unit):
  match xs:
    case Nil{}:
      IO.print("missing")
    case Con{head, tail}:
      IO.write(head)

def main() -> IO(Unit):
  do IO<Unit>:
    IO.write("prefix:")
    xs : List<String> <- IO.args()
    first(xs)
    IO.print_err("warning")
    IO.die(Unit, 7, "stopped")
`,
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
    for (const args of [
      [join(root, "tools/webgpu/run-webgpu.mjs"), artifact],
      [join(root, "tools/webgpu/run-hybrid.mjs"), artifact, wasm],
    ]) {
      const result = spawnSync("node", [...args, "--", "日本語"], {
        encoding: "utf8",
        timeout: 60000,
      });
      assert.equal(result.status, 7);
      assert.equal(result.stdout, "prefix:日本語");
      assert.equal(result.stderr, "warning\nstopped\n");
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
