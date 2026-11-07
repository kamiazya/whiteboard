---
paths:
  - "crates/**"
  - "Cargo.toml"
  - "Cargo.lock"
  - "rust-toolchain.toml"
  - "rustfmt.toml"
  - "deny.toml"
  - ".cargo/**"
  - "tools/checks/src/rust-*.mjs"
---

# crates — the Rust workspace

[ADR-0054](../../docs/contributing/adr/0054-rust-core.md) moves the logic to
Rust, bottom-up and module by module, with the TypeScript implementation as
the byte-identical oracle until each module's switch defaults to Rust. The
requirements every crate is held to are
[quality-requirements.md](../../docs/contributing/quality-requirements.md)
(QR-27 to QR-33); this file is the map and the mechanics.

## Layers and crates

`crates/architecture-map.json` is the one declaration, read by
`cargo xtask arch-map` (which checks the workspace against it both ways) and
by `tools/arch-lint`'s `crate-architecture-map.test.ts` (which checks this
table against it both ways). Every crate of the TARGET graph is declared,
planned ones included, so dependency direction is fixed before code exists.
A layer may depend only on the layers its `mayDependOn` names; a crate only
on its `allowedInternalDeps`; adapters never reach mechanics (ADR-0018 holds
by construction). A `planned` crate has no `Cargo.toml` yet; a `present` one
is a workspace member whose manifest name equals its key.

| crate | layer | status | holds |
|---|---|---|---|
| `whiteboard-det` | core | present | JS-compatible number formatting, pinned math, UTF-16 helpers |
| `whiteboard-log` | core | present | RFC 5424 levels, records, sinks, fields-first logging |
| `whiteboard-edge-routing` | core | present | side choice, anchors, grid search, crossings, jumps, rounding |
| `whiteboard-model` | core | planned | serde types generated from the contracts plus the invariants |
| `whiteboard-facet-engine` | core | planned | facet registry, write validation, compat chain, derived form |
| `whiteboard-scene` | core | planned | the scene vocabulary and the contribution traits |
| `whiteboard-codec` | core | planned | OKF Markdown, JSON Canvas and OCIF serialize and parse |
| `whiteboard-search` | core | planned | tokenizer, BM25 ranking, snippets, searchable text |
| `whiteboard-plugin-visual` | core | planned | the bundled visual plugin as an ordinary contribution |
| `whiteboard-canvas-render` | core | planned | composer, typesetter, line breaking, theme, SVG backend, digest |
| `whiteboard-crdt` | core | planned | the loro bridge, workspace tree, file references, text limits |
| `whiteboard-history` | core | planned | checkpoint scheduling, version retention, frontier encoding |
| `whiteboard-workspace-index` | core | planned | the document index over a workspace tree |
| `whiteboard-reference-graph` | core | planned | per-document reference facts and the backlink aggregate |
| `whiteboard-ports` | ports | planned | async I/O traits (stores, index, blobs, clock, ids) and the error taxonomy |
| `whiteboard-api-contracts` | ops | planned | generated types for /api, sync frames and MCP tool I/O |
| `whiteboard-ops` | ops | planned | every /api/v1 operation and MCP tool as a transport-neutral function |
| `whiteboard-http` | adapters | planned | an axum router over ops, mounted natively and on Workers |
| `whiteboard-mcp` | adapters | planned | a transport-agnostic JSON-RPC dispatcher over the ops tool table |
| `whiteboard-daemon-store` | mechanics | planned | SQLite record store, fs blob store, versions, migrations |
| `whiteboard-edge-store` | mechanics | planned | Durable Object, D1 and R2 stores |
| `whiteboard-wasm` | bindings | present | the wasm-bindgen cdylib for the browser and Node |
| `whiteboard-worker` | bindings | planned | the workers-rs app: router, MCP over HTTP, edge store, alarms |
| `whiteboard-daemon` | bindings | planned | the native daemon binary: UDS server, MCP stdio, native messaging |
| `whiteboard-native-fixture` | bindings | present | a minimal native binary built with the dist-native profile, so the hardening and reproducibility gates have a subject before the daemon exists |
| `xtask` | tooling | present | repository tasks: codegen, arch-map, wasm-imports, cross-target, size, inputs, unsafe-ledger, harden-check, dist, repro-check, notices |
| `whiteboard-fuzz` | tooling | present | cargo-fuzz targets, one per untrusted-input entry |

Core crates are pure: no I/O, `forbid(unsafe_code)`, unchanged on wasm32 and
native. `cargo xtask cross-target` runs each core crate's tests on both
(wasm32 under Node through `wasm-bindgen-test-runner`, `.cargo/config.toml`)
and fails when the two pass different counts, so a test module needs
`#[cfg(target_arch = "wasm32")] use wasm_bindgen_test::wasm_bindgen_test as test;`
to count (QR-21 layer 3). `cargo xtask wasm-imports` fails a core crate whose wasm32 build
imports ANYTHING, with a presence guard on the crate's own function count
(an artifact holding only std passes vacuously; the first LTO'd version did).

## What a change here is held to

`pnpm rust:check` is the merge gate and `pnpm rust:release:check` the
release one; `tools/checks/src/rust-check.mjs` and `rust-release-check.mjs`
list the steps. CI's `rust` job runs both plus `pnpm rust:build:wasm`, and
`rust-fuzz-pr` runs `pnpm rust:fuzz:pr`; both are scoped by PATH
(`PATH_JOBS` in `tools/checks/src/affected.mjs`), so a change to the Cargo
root files, `.cargo/` or `crates/` runs them and not the vitest matrix, and
any other change skips them as a declared skip. After the wasm build the `rust`
job runs `canvas-render-rust` (QR-21 layer 2): canvas-render's
`det-math.rust.test.ts` holds `det-math.ts` to `whiteboard-det` through the
wasm artifact, exact on every double, and fails on CI if the artifact is absent; the
`test-utils/wasm/*.rust.test.ts` beside it do the same for each edge module
ported so far (grid-route, the geometry and ink primitives, edge-rules, the
router's leaves, the router, the anchor pass). The same
project re-runs every `layout/edges` suite, scoreboards included, with
`./grid-route.js` and `./edge-router.js` aliased to the Rust ports through the
wasm (QR-21 layer 1; those suites are included only when the artifact exists),
so the side-choice search and the coincident-ends repair already route through
the Rust router. Every target runs nightly
in `.github/workflows/rust-fuzz-nightly.yml`, whose cache entry the PR job
restores read-only. `ci-rust-jobs.test.ts` holds the jobs' tool versions,
steps and cache paths to the scripts.

- **Toolchain** is `rust-toolchain.toml` (1.97.0, pinned exactly) and
  `wasm-bindgen-cli` 0.2.130, pinned to the crate version. `crates/fuzz` is a
  SEPARATE workspace with its own `Cargo.lock` and a pinned nightly, because
  cargo-fuzz needs one; its library builds on stable so `rust:check` replays
  every committed crash in `regressions/`.
- **Lints** are `[workspace.lints]` in the root `Cargo.toml`, inherited by
  every member (arch-map checks the inheritance, and that `crates/fuzz`'s
  equals the root's): `unsafe_code = forbid`, clippy pedantic with selective
  allows, `unwrap_used`/`expect_used` denied outside tests, and
  `clippy.toml`'s `disallowed-methods` for std's float transcendentals
  (QR-30: non-deterministic across targets; `whiteboard-det` wraps `libm`).
- **Input caps** are `crates/input-caps.json` (QR-28b): every untrusted-input
  entry declares `maxBytes`, `maxDepth`, `maxMillis` and names its
  `fuzzTarget`; `cargo xtask inputs` holds the registry and `crates/fuzz`
  equal from both sides. `template: true` marks the one entry that exists to
  show the shape.
- **Dependencies**: `deny.toml` keeps sources crates.io-only and bans
  `serde_json`'s `unbounded_depth` and `arbitrary_precision`; a third-party
  crate is allowed per crate in the map with its review as the reason.
  `crates/unsafe-ledger.json` is a shrink-only count of the `unsafe` keyword
  in each dependency's source (`cargo xtask unsafe-ledger` lexes it, skipping
  comments and literals — it measures what arrived, not risk), held from
  both sides.
- **Size**: `crates/wasm-size-ledger.json` pins each shipped wasm artifact's
  bytes, ceiling over actual fails and a stale ceiling fails too;
  `cargo xtask size --update` only lowers. It measures the artifact
  `cargo xtask dist wasm` ships — the build `pnpm rust:build:wasm` and
  `repro-check` use too — so `rust:check` needs wasm-bindgen-cli at the
  pinned version.
- **Release gates** (`cargo xtask harden-check <bin>`: PIE, full RELRO, NX,
  no RPATH, stripped, cargo-auditable section; the stack protector is
  REPORTED, required only with `--require-stack-protector`, since stable
  rustc cannot emit one and a Rust-only binary carries no C/C++ — owner
  decision 2026-11-06; `cargo xtask repro-check`: two `dist` builds at
  different paths byte-identical; `cargo xtask notices`: a
  `THIRD-PARTY-NOTICES` per artifact from `crates/about.toml`, whose accepted
  licences must equal `deny.toml`'s). The hardening flags live in
  `cargo xtask dist`, not `.cargo/config.toml`, because any `RUSTFLAGS` in
  the environment silently replaces config rustflags.
- **Panic policy**: wasm builds with `panic = "abort"` — the host recreates
  the instance and rehydrates (`cargo xtask poison-recover` prints the
  scenario and fails until the wasm shim package, `core-wasm`, implements it); the native
  daemon builds with `panic = "unwind"` and `catch_unwind` per request, so
  one request fails rather than the process.

The TypeScript guards reach `.rs` too (`tools/arch-lint`: the file and
function size budgets, vocabulary, the comment guards through a Rust comment
lexer; `.claude/rules/tool-arch-lint.md`). Adding a crate means: a row in
`architecture-map.json`, a row here, and — once it has a manifest — nothing
else, because the map and the workspace are checked against each other.
