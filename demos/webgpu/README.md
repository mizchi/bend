# WebGPU examples

See [the WebGPU guide](../../guide/WEBGPU.md) for setup, architecture, validation
and limitations.

```sh
pnpm install --frozen-lockfile
just setup-wasm
just build-webgpu demos/webgpu/hybrid.bend
just build-hybrid
just run-hybrid
just serve-hybrid
```

`hybrid.bend` transfers a shared tree between Wasm CPU code and two GPU calls.
`higher-order.bend` transfers closures in both directions. `io.bend` and
`file-io.bend` demonstrate injected effects and UTF-8 storage.

`index.html` and `page.mjs` run a generated artifact wholly on the GPU.
`hybrid.html` and `hybrid-page.mjs` run CPU code in Wasm and offload `!` calls.
The independent `term.wgsl`, `probe.wgsl` and `probe.mjs` files test word layout
and cross-pass queue publication; they are not compiler output.

Artifacts use `bend-webgpu-v4`. Rebuild JSON, WGSL and Wasm together.
