import { open } from "node:fs/promises";
import { createFileEffects } from "./file-effects.mjs";
/** Native Node file handles are confined to this provider, never stored in a
 * Bend value. Always dispose the provider, including after cancellation.
 * @param {{args?:string[],env?:Record<string,string>}} [options]
 */
export function createNodeIO(options = {}) {
  /** @type {Map<number,import('node:fs/promises').FileHandle>} */ const handles =
    new Map();
  let next = 1;
  /** @param {number} id */
  const get = (id) => {
    const handle = handles.get(id);
    if (!handle) throw new Error("invalid file handle");
    return handle;
  };
  const handlers = createFileEffects({
    async open(path, mode) {
      if (!["r", "w", "a"].includes(mode)) throw new Error("invalid file mode");
      const handle = await open(path, mode);
      const id = next++;
      handles.set(id, handle);
      return id;
    },
    async read(id, max, offset) {
      const bytes = new Uint8Array(max);
      const result = await get(id).read(bytes, 0, max, offset ?? null);
      return bytes.subarray(0, result.bytesRead);
    },
    async write(id, bytes) {
      let at = 0;
      while (at < bytes.length) {
        const result = await get(id).write(bytes, at, bytes.length - at, null);
        if (!result.bytesWritten)
          throw new Error("file write made no progress");
        at += result.bytesWritten;
      }
    },
    async size(id) {
      return (await get(id).stat()).size;
    },
    async close(id) {
      const h = get(id);
      handles.delete(id);
      await h.close();
    },
  });
  return {
    io: { ...options, handlers },
    async dispose() {
      await Promise.all([...handles.values()].map((h) => h.close()));
      handles.clear();
    },
  };
}
