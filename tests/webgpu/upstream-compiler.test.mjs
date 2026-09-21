import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
const root = resolve(import.meta.dirname, "../..");

test("optional host hooks preserve native C tokens, including after host compilation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bend native preservation "));
  try {
    const baseline = join(dir, "comp.ts");
    await writeFile(
      baseline,
      execFileSync(
        "git",
        ["show", "75cb8f3e041aeaad2b37e726c0a33ba19dc49df8:bend2/comp.ts"],
        { cwd: root },
      ),
    );
    await symlink(join(root, "bend2/bend.ts"), join(dir, "bend.ts"));
    const runner = join(dir, "compare.ts");
    await writeFile(
      runner,
      `
      import * as Bend from ${JSON.stringify(join(root, "bend2/bend.ts"))};
      import {compile_book} from ${JSON.stringify(baseline)};
      import {loadHostCompiler,compileHost} from ${JSON.stringify(join(root, "bend2/webgpu/upstream.ts"))};
      import {writeFileSync} from 'node:fs';
      const load = async () => {
        const book = Bend.book_nil();
        await Bend.book_load(book,process.argv[2],'',new Map());
        Bend.book_valid(book);
        return book;
      };
      const patched = await loadHostCompiler();
      await compileHost(await load());
      writeFileSync(process.argv[3],compile_book(await load()));
      writeFileSync(process.argv[4],patched.compile_book(await load()));
    `,
    );
    for (const fixture of [
      "demos/webgpu/hybrid.bend",
      "demos/webgpu/higher-order.bend",
      "tests/base/string_kit.bend",
    ]) {
      const original = join(dir, "original.c"),
        patched = join(dir, "patched.c");
      execFileSync("bun", [runner, join(root, fixture), original, patched]);
      const preprocess = (file) =>
        execFileSync("clang", ["-E", "-P", "-x", "c", file], {
          encoding: "utf8",
        })
          .split("\n")
          .filter((line) => line.trim())
          .join("\n");
      assert.equal(preprocess(patched), preprocess(original), fixture);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
