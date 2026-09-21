import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import type * as Bend from "../../bend2/bend.ts";
import { lowerBook } from "../../bend2/webgpu/frontend.ts";
import { emitWGSL } from "../../bend2/webgpu/emit.ts";
import { compileHost } from "../../bend2/webgpu/upstream.ts";
import type { Artifact } from "../../bend2/webgpu/ir.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const sha256 = (data: Uint8Array) =>
  createHash("sha256").update(data).digest("hex");

async function main() {
  const [input, output, ...extra] = process.argv.slice(2);
  if (!input || !output || extra.length || !output.endsWith(".json")) {
    throw new Error(
      "usage: bun tools/webgpu/build-webgpu.ts input.bend output.json",
    );
  }
  const source = resolve(input);
  const target = resolve(output);
  const checked = spawnSync(
    resolve(root, "tools/webgpu/bend.sh"),
    [source, "--check-only"],
    { stdio: ["ignore", "ignore", "pipe"], encoding: "utf8" },
  );
  if (checked.error) throw checked.error;
  if (checked.status !== 0)
    throw new Error(checked.stderr || "Bend type checking failed");
  const repo = root;
  const compiler = await readFile(resolve(repo, "bend2/bend.ts"));
  const base = await readFile(resolve(repo, "bend2/base.bend"));
  if (
    sha256(compiler) !==
      "429966632dc6a5ec7fcc7a13515822362819a8d9bffcaecc5b4eb37e99960fed" ||
    sha256(base) !==
      "f1a346abe7d354f1e36de235b17274b4d7d81424419f982d545bd0cc009ca36c"
  ) {
    throw new Error(
      "unsupported Bend frontend/Base revision; revalidate the scalar ABI before porting",
    );
  }
  const api: typeof Bend = await import(
    pathToFileURL(resolve(repo, "bend2/bend.ts")).href
  );
  const book = api.book_nil();
  await api.book_load(book, source, "", new Map());
  api.book_valid(book);
  if (book.hols || book.open) throw new Error("unresolved Bend holes");
  const host = await compileHost(book);
  const ir = lowerBook(book, api, host.metadata);
  const emitted = emitWGSL(
    ir,
    await readFile(resolve(root, "bend2/webgpu/runtime.wgsl"), "utf8"),
  );
  const revision = spawnSync("git", ["-C", repo, "rev-parse", "HEAD"], {
    encoding: "utf8",
  });
  const artifact: Artifact = {
    host,
    abi: ir.abi,
    ir,
    ...emitted,
    provenance: {
      bendCommit: revision.status === 0 ? revision.stdout.trim() : "unknown",
      sourceSha256: sha256(await readFile(source)),
      compilerSha256: sha256(compiler),
    },
  };
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, JSON.stringify(artifact, null, 2) + "\n");
  await writeFile(target.slice(0, -5) + ".wgsl", artifact.shader);
  console.log(target);
}
main().catch((error) => {
  console.error(
    `build-webgpu: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
});
