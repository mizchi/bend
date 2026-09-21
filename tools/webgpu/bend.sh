#!/usr/bin/env bash
set -euo pipefail
BEND_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
exec bun "$BEND_ROOT/bend2/main.ts" "$@"
