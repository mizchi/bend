#!/usr/bin/env bash
set -euo pipefail
BEND_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SDK="$BEND_ROOT/build/emsdk"
# Use a specific SDK release; everything stays under the ignored build/ tree.
if [[ ! -d "$SDK/.git" ]]; then
  git clone --depth 1 --branch 4.0.15 https://github.com/emscripten-core/emsdk.git "$SDK"
fi
SDK_PYTHON="${PYTHON:-}"
if [[ -z "$SDK_PYTHON" ]]; then
  for candidate in python3 python3.14 python3.13 python3.12 python3.11 python3.10; do
    if command -v "$candidate" >/dev/null && "$candidate" -c 'import sys; sys.exit(sys.version_info < (3, 10))'; then
      SDK_PYTHON="$candidate"
      break
    fi
  done
fi
if [[ -z "$SDK_PYTHON" ]]; then
  echo 'Python 3.10+ is required for emsdk. Set PYTHON to its executable.' >&2
  exit 1
fi
"$SDK_PYTHON" "$SDK/emsdk.py" install 4.0.15
"$SDK_PYTHON" "$SDK/emsdk.py" activate 4.0.15
