"""Compile this checkout's native C runtime to sequential Wasm for comparison."""
import argparse
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[2]
SUPPORTED_EFFECTS = {"IO_PRINT", "IO_PRINT_ERR", "IO_WRITE", "IO_ARGS", "IO_NOW"}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    if args.output.suffix != ".mjs":
        parser.error("output must end in .mjs (also emits .wasm)")
    emcc = os.environ.get("EMCC") or shutil.which("emcc")
    if not emcc:
        local = ROOT / "build/emsdk/upstream/emscripten/emcc"
        emcc = str(local) if local.is_file() else None
    if not emcc:
        parser.error("emcc not found. Run `just setup-wasm` or set EMCC.")
    output = args.output.resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="bend-wasm-") as directory:
        c = Path(directory, "program.c")
        subprocess.run([str(ROOT / "tools/webgpu/bend.sh"), str(args.source.resolve()), "-o", str(c)], check=True)
        effects = set(re.findall(r"io_eff\(CID_([A-Z_0-9]+),", c.read_text()))
        unsupported = effects - SUPPORTED_EFFECTS
        if unsupported:
            raise ValueError("unsupported sequential Wasm effects: " + ", ".join(sorted(unsupported)) + "; use the hybrid host")
        subprocess.run([
            emcc, str(c), "-std=c11", "-O2", "-mtail-call", "-lm",
            "-sMODULARIZE=1", "-sEXPORT_ES6=1", "-sENVIRONMENT=web,worker,node",
            "-sINVOKE_RUN=0", "-sEXIT_RUNTIME=1", "-sEXPORTED_RUNTIME_METHODS=callMain",
            "-sSTACK_SIZE=1048576", "-sINITIAL_MEMORY=100663296",
            "-sALLOW_MEMORY_GROWTH=1", "-sMAXIMUM_MEMORY=268435456",
            "-o", str(output),
        ], check=True)
    print(output)


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, subprocess.CalledProcessError) as error:
        print("build-wasm: " + str(error), file=sys.stderr)
        sys.exit(1)
