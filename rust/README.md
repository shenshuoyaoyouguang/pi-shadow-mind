# pi-shadow-kernel (Rust → WASM)

Pure computational kernel of `pi-shadow-mind`, reconstructed in Rust and compiled
to WebAssembly. The TypeScript modules keep their exported signatures; the WASM
kernel is inlined into the ESM bundle as base64, so no platform binaries ship and
all existing build invariants stay intact.

## Layout

```
rust/
  pi-shadow-kernel/          Rust crate (cdylib + rlib)
    src/
      lib.rs                 crate root + wasm32 global allocator
      exports.rs             wasm-bindgen JSON-string boundary (wasm32 only)
      types.rs               domain structs (camelCase serde)
      util.rs                UTF-16 / codepoint / flatten helpers
      validation.rs          thinking-level + string-array checks
      usage.rs               usage formatting + addUsage
      summaries.rs           built-in tool-result summarizers
      scheduler.rs           deterministic prefilter + matchesModel
      protocol.rs            shadow-request construction + brief sanitize
      trajectory.rs          trajectory serialization + feedback budget
      config.rs              config parse/serialize (snake_case ↔ camelCase)
      registry.rs            shadow-definition validation/normalization
      gatekeeper.rs          prompt build + trajectory fit + reply parse
    tests/                   integration tests mirroring test/*.test.ts
    Cargo.toml
  build-wasm.mjs             wasm-pack → base64 → src/generated/*
  README.md
```

## Toolchain

- Rust stable (≥ 1.80) with the `wasm32-unknown-unknown` target:
  `rustup target add wasm32-unknown-unknown`
- `wasm-pack` (≥ 0.12): `cargo install wasm-pack`

## Build the WASM kernel

From the repo root:

```sh
node rust/build-wasm.mjs
```

This runs `wasm-pack build --target web`, base64-encodes the `.wasm`, and
regenerates `src/generated/kernel-wasm.ts` (the base64 + `KERNEL_WASM_READY`)
and `src/generated/kernel-glue.js` (the wasm-bindgen glue with a named `init`
export). After this, `npm run build` bundles the inlined kernel normally — no
change to `scripts/build.mjs` or any existing source file.

Until the first WASM build, the generated files are inert placeholders
(`KERNEL_WASM_READY = false`, glue stubs that throw), so `npm run verify` and
`npm run build` pass without a Rust toolchain installed.

## Run the Rust tests

```sh
cd rust/pi-shadow-kernel
cargo test
```

The `tests/` files mirror the assertions in `test/scheduler.test.ts`,
`test/usage.test.ts`, `test/gatekeeper.test.ts`, plus behavioral tests for
config/protocol/trajectory/registry/summaries. They run on the host (`rlib`),
not in the browser.

## What stays in TypeScript

- `runtime.ts` (orchestration), all `*Store`/fs classes, `runGatekeeper` and
  auth hydration (thin `pi-ai` wrappers), YAML frontmatter parsing, and the
  custom `registerToolResultSummarizer` plugin extension point.
- The Rust kernel is wired in progressively by swapping a module's internal
  import from `./scheduler.js` (etc.) to `./wasm-kernel.js`. Existing modules
  are not modified until that migration step.

## String-JSON boundary

Every `#[wasm_bindgen]` export in `exports.rs` takes JSON strings (or primitives)
and returns JSON strings / bools. `src/wasm-kernel.ts` is the stable typed layer
that `JSON.stringify`s inputs and `JSON.parse`s outputs, so callers see the same
TS signatures as the original modules.
