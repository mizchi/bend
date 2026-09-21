import { data, done, fail } from "./effects.mjs";
/** @typedef {{open:(path:string,mode:string)=>Promise<number>,read:(handle:number,max:number,offset?:number)=>Promise<Uint8Array>,
 * write:(handle:number,bytes:Uint8Array)=>Promise<void>,size:(handle:number)=>Promise<number>,close:(handle:number)=>Promise<void>}} FileStorage */
/** Create the Bend File.* protocol from an injected storage capability.
 * @param {FileStorage} storage @returns {Record<string,import('./effects.mjs').EffectHandler>}
 */
export function createFileEffects(storage) {
  /** @param {unknown} error */
  const failure = (error) =>
    fail(
      Math.abs(Number(/** @type {{errno?:number}} */ (error)?.errno ?? 5)),
      error instanceof Error ? error.message : String(error),
    );
  /** @param {Uint8Array} bytes @returns {import('./effects.mjs').HostValue} */
  const list = (bytes) => {
    let value = data("Nil");
    for (let i = bytes.length - 1; i >= 0; i--)
      value = data("Con", bytes[i], value);
    return value;
  };
  /** @param {import('./ir.ts').Word} value @param {import('./effects.mjs').EffectContext} ctx */
  const bytes = (value, ctx) => {
    const result = [];
    for (let i = 0; i < 1_000_000; i++) {
      const node = ctx.node(value);
      if (node.constructor === "Nil") return new Uint8Array(result);
      if (node.constructor !== "Con") throw new Error("expected List<U32>");
      const n = Number(ctx.number(node.fields[0]));
      if (n > 255)
        throw Object.assign(new Error("invalid byte"), { errno: 22 });
      result.push(n);
      value = node.fields[1];
    }
    throw new Error("file byte budget exhausted");
  };
  /** @type {Record<string,import('./effects.mjs').EffectHandler>} */
  const handlers = {
    "File.open": async ([path, mode], ctx) => {
      try {
        return done(await storage.open(ctx.text(path), ctx.text(mode)));
      } catch (e) {
        return failure(e);
      }
    },
    "File.close": async ([file], ctx) => {
      await storage.close(Number(ctx.number(file)));
      return data("Unit");
    },
  };
  for (const name of [
    "File.read",
    "File.read_bytes",
    "File.read_at",
    "File.size",
    "File.write",
    "File.write_bytes",
  ]) {
    handlers[name] = async ([file, ...args], ctx) => {
      const handle = Number(ctx.number(file));
      try {
        /** @type {import('./effects.mjs').HostValue} */ let result;
        if (name === "File.size") result = await storage.size(handle);
        else if (name === "File.write" || name === "File.write_bytes") {
          await storage.write(
            handle,
            name === "File.write"
              ? new TextEncoder().encode(ctx.text(args[0]))
              : bytes(args[0], ctx),
          );
          result = data("Unit");
        } else {
          const count = Number(
            ctx.number(args[name === "File.read_at" ? 1 : 0]),
          );
          if (count > 1_000_000) throw new Error("file read budget exhausted");
          const buffer = await storage.read(
            handle,
            count,
            name === "File.read_at" ? Number(ctx.number(args[0])) : undefined,
          );
          result =
            name === "File.read"
              ? new TextDecoder().decode(buffer)
              : list(buffer);
        }
        return data("Tuple", handle, done(result));
      } catch (e) {
        return data("Tuple", handle, failure(e));
      }
    };
  }
  return handlers;
}

/** An isolated browser-friendly filesystem. Each runner owns its handle table.
 * @param {Record<string,string>} [initial]
 */
export function createMemoryFiles(initial = {}) {
  const files = new Map(
    Object.entries(initial).map(([path, text]) => [
      path,
      new TextEncoder().encode(text),
    ]),
  );
  /** @type {Map<number,{path:string,position:number,mode:string}>} */ const handles =
    new Map();
  let next = 1;
  /** @param {number} id */
  const get = (id) => {
    const file = handles.get(id);
    if (!file) throw new Error("invalid file handle");
    return file;
  };
  /** @param {string} path */
  const content = (path) => {
    const bytes = files.get(path);
    if (!bytes) throw new Error("File not found");
    return bytes;
  };
  /** @type {FileStorage} */
  const storage = {
    async open(path, mode) {
      if (!["r", "w", "a"].includes(mode)) throw new Error("invalid file mode");
      if (mode === "r" && !files.has(path))
        throw Object.assign(new Error("File not found"), { errno: 2 });
      if (mode === "w" || !files.has(path)) files.set(path, new Uint8Array());
      const id = next++;
      handles.set(id, {
        path,
        position: mode === "a" ? content(path).length : 0,
        mode,
      });
      return id;
    },
    async read(id, max, offset) {
      const h = get(id);
      if (h.mode !== "r") throw new Error("file is not readable");
      const at = offset ?? h.position,
        bytes = content(h.path).slice(at, at + max);
      if (offset === undefined) h.position += bytes.length;
      return bytes;
    },
    async write(id, bytes) {
      const h = get(id);
      if (h.mode === "r") throw new Error("file is not writable");
      const old = content(h.path);
      if (h.mode === "a") h.position = old.length;
      const result = new Uint8Array(
        Math.max(old.length, h.position + bytes.length),
      );
      result.set(old);
      result.set(bytes, h.position);
      h.position += bytes.length;
      files.set(h.path, result);
    },
    async size(id) {
      return content(get(id).path).length;
    },
    async close(id) {
      handles.delete(id);
    },
  };
  return {
    handlers: createFileEffects(storage),
    files,
    dispose: () => handles.clear(),
  };
}
