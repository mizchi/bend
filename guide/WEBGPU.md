# Experimental WebGPU and Wasm backend

This branch adds a WebGPU backend and a Wasm CPU host to Bend. GPU-only execution
runs the entry on WebGPU. Hybrid execution runs ordinary calls in Wasm and
suspends at explicit `!` calls, dispatches them to WebGPU, and resumes the CPU
continuation. Browser WebGPU and Dawn's Node binding use the same JavaScript
runtime.

The implementation was moved from the `mizchi/bend-playground` experiment into
this fork. It starts at upstream commit
`75cb8f3e041aeaad2b37e726c0a33ba19dc49df8`. `bend2/bend.ts` is unchanged. The Wasm
platform and optional host hooks live directly in `bend2/comp.ts`; compilation
requires no sibling checkout, staged compiler, patch files or generated-C
rewriting. This is experimental work, not an upstream release.

## Build and run

Install Bun, Node.js 24+, pnpm 10 and just. An available WebGPU adapter is
required for GPU tests and execution.

```sh
pnpm install --frozen-lockfile
just build-webgpu
just run-webgpu                  # Dawn; prints 4294443008
just serve-webgpu                # http://127.0.0.1:8001

just setup-wasm                  # Emscripten 4.0.15, local to build/
just build-webgpu demos/webgpu/hybrid.bend
just build-hybrid
just run-hybrid                  # Wasm CPU + Dawn GPU
just serve-hybrid                # http://127.0.0.1:8002/hybrid.html
```

`EMCC` may select an existing Emscripten executable instead of installing the
local SDK. Build products, GPU libraries, dependency installations and browser
reports remain untracked. The ordinary CLI (`bun bend2/main.ts`) keeps its
existing interface; the experimental build/run commands live in `tools/webgpu`.

For a sequential comparison, `just build-wasm` compiles this checkout's normal
C output to Wasm, and `just run-wasm` executes it. This route supports pure code
and a small console-IO subset; the hybrid host handles asynchronous capabilities.

## Code layout

| Location | Responsibility |
| --- | --- |
| `bend2/comp.ts` | Existing C/JS compiler, Wasm platform support, optional host hooks |
| `bend2/webgpu/frontend.ts` | Checked Book to typed WGSL backend IR |
| `bend2/webgpu/emit.ts`, `runtime.wgsl` | Program-specific shader and GPU scheduler |
| `bend2/webgpu/runtime.mjs` | WebGPU resources, dispatch, graph upload/readback |
| `bend2/webgpu/upstream.ts`, `closure-bridge.ts` | Host contracts and closure/layout matching |
| `bend2/webgpu/upstream-host.c` | Asynchronous boundary around upstream tasks |
| `bend2/webgpu/upstream-graph.mjs`, `hybrid.mjs` | Native value conversion and Wasm coordination |
| `bend2/webgpu/effects.mjs`, `file-effects.mjs`, `node-io.mjs` | Injected host capabilities |
| `tools/webgpu/` | Build, run, SDK setup and type-check commands |
| `tests/webgpu/` | Node/Dawn, Chromium and differential regressions |
| `demos/webgpu/` | Runnable examples, browser pages and independent queue probes |

The compiler reuses `book_load`, `book_valid` and checked `Def.e`. It does not
modify the parser/checker or recognize example names. The artifact contract in
`bend2/webgpu/ir.ts` is `bend-webgpu-v4`. Rebuild JSON, WGSL and Wasm together;
older Playground artifacts can lack the native host metadata.

## CPU/GPU boundary

`compile_host` emits upstream C plus physical layout, borrowing and closure
capture metadata. Explicit offloads receive wrapper definitions in the checked
Book, so primitive inlining cannot swallow `!` and ordinary calls to the same
function remain CPU calls. C evaluation, allocation, reference counting,
closure application and task delivery use the existing upstream runtime.

The host bridge returns at GPU requests, IO requests, completion or budget
yields. Segment transitions consume a budget and preserve the evaluation stack
and register bank on suspension. GPU results return through `task_deliver`; IO
results are applied to the suspended continuation. Parallel bindings outside a
GPU call run sequentially in the Wasm host.

Native packed constructors, flattened values and Array blocks are translated to
the external WGSL graph representation. Borrowed arguments remain owned by their
CPU continuation. Shared constructors retain sharing when permitted by native
ownership metadata. Long recursive values use queued JavaScript traversal.
Closures use generated native capture layouts and alpha-matched checked bodies.

The Wasm module imports only four diagnostic WASI functions supplied by the
coordinator: `fd_write`, `fd_close`, `fd_seek`, `proc_exit`. Foreign C effect
implementations are omitted in host mode; actual IO uses explicitly supplied
JavaScript capabilities. No Asyncify, JSPI, Emscripten JS loader, ambient
filesystem or ambient network is required for hybrid execution. A SHA-256
fingerprint rejects mismatched Wasm/artifact pairs.

Host mode disables flat C loop helpers so loops can yield. Constant folding and
arity raising are also disabled in that mode to preserve closure correspondence.
Normal native compilation retains those optimizations. CPU performance parity
has not been measured.

## Supported behavior and capabilities

The current subset includes U32, 48-bit Nat, Bool, recursive algebraic data,
shared immutable values, String/Char, Array operations, fork/join, closures,
partial application, higher-order Array.map, erased arguments/fields and IO
continuations. The GPU runtime uses bounded task/frame/heap resources and reports
exhaustion; there is no silent CPU fallback.

`runHybrid(program, wasmBytes, options)` and `runProgram(program, options)` return
`stdout`, `stderr`, exact `output` events, `exitCode`, `value` and `stats`.
An IO main's `value` represents Unit; printed output lives in the output fields.
Options include `gpu`, `signal`, `onPrint` and `io` capabilities. The hybrid host
also accepts `hostBudget` and `maxHostSteps`.

Standard capabilities cover output, arguments, environment lookup, time, random
U32, sleep and process-style exit without terminating the embedding page.
`io.handlers` can supply additional typed Base effects. Node file adapters use
the native filesystem; browser applications can inject `createMemoryFiles()` or
a storage adapter. Missing capabilities fail explicitly.

The shared-tree demo makes a tree on the GPU, transfers it to Wasm, uploads it
for a second GPU call, and then reads the original borrowed value on the CPU.
It prints `352` and `176`. `higher-order.bend`, `io.bend` and `file-io.bend`
exercise captured/returned closures, typed effects and UTF-8 file round trips.

## Validation

```sh
just check-webgpu
just test-dawn
just check-webgpu-compat
pnpm exec playwright install chromium
just test-webgpu
# Or run the four local backend gates in sequence:
just test
```

The type gate checks `comp.ts`, the backend and build tools. Existing diagnostics
inside the unchanged human-written `bend.ts` are excluded. The native-regression
test loads the baseline compiler from Git history, so it requires that baseline
commit to be available (use a full clone).

The migration was validated on Apple M5 / macOS 26.6.2, Node 24.21.0,
Emscripten 4.0.15, Dawn `webgpu@0.6.1` and Chromium 153.0.8010.12. The local matrix
covers shared trees, higher-order values, IO, scalar boundaries, erasure, upstream
String tests, packed and wide Array transfers, a 12,000-code-point Unicode IO
string, and cancellation during a long CPU loop. Three representative programs
also compare preprocessed native C tokens with the baseline compiler, including
compilation after host mode. Upstream's cluster gates are separate.

Migration results (2026-09-22): type checking passed; Node/Dawn 14/14,
native differential 15/15, and Chromium 23/23 passed.
The repository shape gate includes the new optional files. Its `comp.ts` token
allowance is raised from 65,000 to 67,000 for the added platform/host hooks
(measured baseline 64,936; this branch 66,609). Other existing caps are unchanged.

## Limits

- Concrete Array layouts cross typed boundaries. Arrays hidden behind erased
  boxed fields can lack element/stride metadata and are rejected.
- Native closure forms without a matching WGSL body are rejected. Shared stable
  compiler identities would be preferable to structural matching.
- The WGSL frontend subset still limits accepted programs, including CPU-heavy
  hybrid programs. F32, mutable atomic arrays, concurrent IO tasks/channels, and
  built-in network/GUI/audio providers are not implemented.
- Wasm uses a fixed 64 MiB corpus, an 8 MiB evaluation stack and 65,536 pending
  task slots. Host steps default to 4,096 segment transitions and 100,000 steps.
- GPU defaults are 1,024 tasks, 64 frames per task and 32,768 heap nodes. A
  function can use at most 128 registers; constructors/captures/forks are limited
  to eight fields/items. Exhaustion is an error.
- Cancellation occurs between CPU segments, GPU rounds and asynchronous IO.
  One native primitive, graph transfer or submitted GPU dispatch is not
  preemptible.
- GPU result readback snapshots the heap before compacting the reachable graph.
  Device/pipeline reuse and GPU-driven round batching remain future work.
- Only Apple Metal through Chromium and Dawn has been validated. Other browsers
  and drivers need testing; no GPU speedup is claimed.

Dawn's native Node binding shares the same host runtime as browser WebGPU.
The C++/`emdawnwebgpu` approach described in
[Chrome's cross-platform guide](https://developer.chrome.com/docs/web-platform/webgpu/build-app?hl=en)
was considered but is not required by this implementation. It would replace the
host binding layer; WGSL generation and value conversion would still be needed.
