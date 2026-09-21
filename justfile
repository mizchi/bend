set positional-arguments
export BEND_NO_TELEMETRY := "1"

# List local experimental backend tasks.
default:
    @just --list

# Run the compiler from this checkout.
bend +args:
    ./tools/webgpu/bend.sh "$@"

# Install the pinned Emscripten SDK under ignored build/.
setup-wasm:
    bash tools/webgpu/setup-wasm.sh

# Compile an experimental WGSL artifact and upstream C host metadata.
build-webgpu source="tests/webgpu/fixtures/s10_gpu.bend" output="build/webgpu/program.json":
    bun tools/webgpu/build-webgpu.ts {{quote(source)}} {{quote(output)}}

# Execute on Dawn's native WebGPU binding.
run-webgpu program="build/webgpu/program.json" *args:
    node tools/webgpu/run-webgpu.mjs "$@"

# Compile the artifact's upstream C and asynchronous host bridge to Wasm.
build-hybrid program="build/webgpu/program.json" output="build/webgpu/host.wasm":
    bun tools/webgpu/build-hybrid.ts {{quote(program)}} {{quote(output)}}

# Run CPU code in Wasm and explicit ! calls through Dawn.
run-hybrid program="build/webgpu/program.json" wasm="build/webgpu/host.wasm" *args:
    node tools/webgpu/run-hybrid.mjs "$@"

# Sequential C/Wasm reference, without generated-C rewriting.
build-wasm source="tests/webgpu/fixtures/s10_gpu.bend" output="build/wasm/program.mjs":
    python3 tools/webgpu/build-wasm.py {{quote(source)}} {{quote(output)}}

run-wasm module="build/wasm/program.mjs" *args:
    node tools/webgpu/run-wasm.mjs "$@"

# Stage the shared browser runtime and standalone diagnostic probes.
prepare-webgpu:
    mkdir -p build/webgpu/backend
    cp bend2/webgpu/*.mjs build/webgpu/backend/
    cp demos/webgpu/probe.mjs demos/webgpu/probe.wgsl demos/webgpu/term.wgsl build/webgpu/
    cp demos/webgpu/index.html demos/webgpu/page.mjs demos/webgpu/hybrid.html demos/webgpu/hybrid-page.mjs build/webgpu/

build-webgpu-browser: build-webgpu prepare-webgpu

build-hybrid-browser: (build-webgpu "demos/webgpu/hybrid.bend") build-hybrid prepare-webgpu

serve-webgpu: build-webgpu-browser
    python3 -m http.server 8001 --bind 127.0.0.1 --directory build/webgpu

serve-hybrid: build-hybrid-browser
    python3 -m http.server 8002 --bind 127.0.0.1 --directory build/webgpu

check-webgpu:
    node tools/webgpu/check-webgpu.mjs

test-dawn:
    node --test --test-concurrency=1 tests/webgpu/*.test.mjs

check-webgpu-compat:
    node --test --test-concurrency=1 tests/webgpu/compatibility.mjs

test-webgpu:
    pnpm exec playwright test --config playwright.webgpu.config.mjs

# Local backend checks; upstream's cluster gates remain separate.
test: check-webgpu test-dawn check-webgpu-compat test-webgpu
