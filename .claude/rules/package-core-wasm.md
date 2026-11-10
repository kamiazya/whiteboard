---
paths:
  - "packages/core-wasm/**"
---

# core-wasm — the Rust core behind a thin shim

[ADR-0054](../../docs/contributing/adr/0054-rust-core.md) keeps this package
in TypeScript: the wasm artifact, a shim, and init. The logic is Rust's
(`crates/`, `.claude/rules/crates.md`); what lives here is only the boundary.

## What belongs here

- `loadCore(source)` / `coreFrom(glue, source)`: init from the artifact's
  bytes or a compiled `WebAssembly.Module` that a COMPOSITION ROOT hands over
  (a Vite `?url` import, `fs` in mcp-server, a module import on Workers).
  The shim never fetches or reads a file itself, and imports no `node:*`.
  `loadCore` is its own entry (`./load`), the one runtime import of
  `#glue`, so a root that BUNDLES the shim and loads the glue by path at
  run time (mcp-server's `packages/mcp-server/src/server/export/layout-core.ts`) takes `coreFrom` from `.`
  and its build needs no artifact. `./wasm` exports the `.wasm` itself, for a
  browser root that fetches it from where its bundler serves it
  (apps/web's `layout-core-source.ts`).
- The ABI check at init (`EXPECTED_ABI` against `abi_version()`): the shim
  and the artifact come from one commit, and a pair that does not is refused
  as `CoreAbiMismatch` rather than failing on its first mismatched call.
- One typed call per user operation (QR-22b): `routeLayout` encodes a whole
  layout's routing onto the typed-array wire (`wire.ts`, the layout
  `crates/bindings/wasm` decodes), makes ONE call, decodes the routes and
  the anchors the side search settled (the editor freezes a drag from
  them), and writes the budget accounts back. It satisfies canvas-render's
  `RoutingCore` structurally, which is how a root hands it to the layout.
  `parseOkf` / `serializeOkf` are one call each the same way: only the head
  (the fences and the frontmatter) crosses — the shim cuts it with
  `parseOkf`'s own pattern, slices the body from its own string, and marks a
  lone surrogate in the head so Rust can refuse it where the TypeScript does —
  and an unwritable document throws `CoreOkfUnwritable` carrying the
  TypeScript's `issues` (path and reason, in its order), which codec rethrows
  as `OkfNotYamlSafeError`. A value only the host can hold is walked by
  `okf-unsafe.ts`, a port of the TypeScript's own walk.
- Refusing, as `CoreInputRefused` with a `code` from the generated
  `RefusalCode` (`src/generated/input-caps.ts`, `cargo xtask codegen` from
  `crates/input-caps.json`, so both languages refuse by one cap, QR-28b):
  - `input-too-large`: the encoded wire is past the entry's `maxBytes`,
    refused BEFORE the artifact is called — the export refuses the same
    length by the same generated constant.
  - `malformed`: an answer it cannot fully account for — a count past what
    is left, a side, end or flag out of range, an anchor naming no edge. The
    count is checked BEFORE anything is allocated, since it is the
    artifact's word.

  A composition root answers either refusal from the TypeScript. For OKF that is codec's
  switch (`okfCodec`), which treats any throw from these calls as a decline; for routing it
  is canvas-render's `routeLayout`.

## What does NOT belong here

- Anything that imports canvas-render. The composer will take this package's
  implementation through its layout options, so the dependency points from
  the roots to both, never from here to canvas-render. Its input types are
  declared structurally in `types.ts` for that reason.
- Recovery from a trapped instance: `cargo xtask poison-recover` names the
  module that will own it and fails until it exists.

## The artifact

`artifacts/` is gitignored and built in the pipeline (owner decision,
2026-11-08): `pnpm --filter @kamiazya/whiteboard-core-wasm build:wasm` runs
`pnpm rust:build:wasm` (the one build path the size ledger and the
reproducibility check measure) and `stage:wasm` copies it in. There is no
`build` script, so `pnpm -r build` and the release path need no Rust yet.
In CI, `.github/actions/core-wasm` restores it from a cache keyed on its
inputs and builds and saves it only on a miss (owner decision, 2026-11-08);
a job that lays out through the core in `differential` uses that action.

`#glue` (package `imports`) is declared by hand in `src/glue.d.ts`, so
`tsc` needs no artifact: the TypeScript jobs and the pre-push hook have no
Rust toolchain. Three checks keep the declaration honest — the runtime ABI
check, `typecheck:abi` (`abi-conformance.ts` beside `src`, compiled in the
`rust` job against the generated declaration), and core-wasm-rust.

## Tests

- `core-wasm-node`: the shim over a fake glue — the wire layout, decoding,
  the budget writeback, both refusals. Runs anywhere.
- `core-wasm-rust`: the shim over the staged artifact. CI runs it in the
  `rust` job after the wasm build.
- What the shim ROUTES is held to the TypeScript composer by canvas-render's
  `route-layout.rust.test.ts`, which goes through `coreFrom`.
