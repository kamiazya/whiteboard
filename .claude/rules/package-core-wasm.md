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
  as `CoreAbiMismatch` rather than failing on its first mismatched call. The
  test lanes' oracle build (`oracle-surface`, `pnpm rust:build:wasm:oracle`)
  reports `ORACLE_ABI`, which the shim also accepts (its production exports
  are the shipped ones); canvas-render's layer-2 glue accepts only that one,
  since the per-module exports it calls exist in no shipped artifact.
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
  `facetBucketCheck(target, bucket, library?)` is `partitionFacetWrites` plus the
  stencil library's refusal in one call (`facet-write.ts`, `facet_bucket_check`):
  the bucket crosses in `Object.entries` order and is answered as the sets (bit
  for bit, with their key order) and the deletions, or the first key refused with
  its stage and what the stage says (`FacetRefusal`: the issues carry path and code
  in order, and no sentence, which the root words, q43). The shim stops the bucket at
  the first payload holding `__proto__` and answers `reserved-key` there unless a key
  before it is refused, because the server's walk throws at that point; it declines
  a value the wire cannot carry, among them an `undefined` the TypeScript reads as an
  absent key and would have accepted; the daemon refuses those as a rejected facet
  write, since there is no TypeScript judgement left to answer them (S8 stage 4).
  `library` is the workspace's stored stencils by bare name, passed only for a
  bucket that writes a stencil. Held to the recorded oracle
  (`oracle/facet-write.jsonl`) by `crates/bindings/wasm/tests/facet_write_oracle.rs`,
  the shim over the artifact by `facet-write.rust.test.ts`, and what the daemon's
  writer does with the answer by server-core's `facet-write.dispatch.test.ts`.
- A layout, note or comment request, and the `edges` query, may carry `svg`
  (the envelope a picture is drawn in: `viewBox` — `'document'`, the
  server's, or `{of: 'scene' | 'document', margin?}`, the web's `sceneBounds`
  / `sceneDocumentBounds(scene, margin)` — `width`, `height`, `padding`,
  `background`, `textFill`, `rasterScale`, `legend: 'omit'`, and
  `form: 'keyed'`); the answer then carries the core's SVG of the scene (for
  `edges`, of the layer as a scene of its own) last, after any fragment
  sources, as the document's text or the keyed projection
  `[rootOpen, attrs, groups]`, which the shim reads into
  `KeyedSvgRender`'s shape (`layout.ts`'s `pictureOf`). canvas-render's
  `core-picture.ts` asks for it (`layoutSpatialCanvasPicture`, its keyed
  sibling, the note's and the comment's, `layoutSpatialEdgesPicture`), held
  byte for byte to the TypeScript backend by `core-picture.rust.test.ts` (the
  server's envelopes) and `core-picture-web.rust.test.ts` (each web caller's
  exact option set). server-core's `wb_scene_render`, the `canvas_view`
  picture and mcp-server's file export take their SVG from it (ADR-0054 A2);
  in the web, the drag overlay's edge layer does (`use-drag-layers.ts`'s
  `liveEdges`, A3.2), held by `drag-overlay-core.browser.test.tsx`, and so
  do the editor surface, the drag layers, a list row's picture and the export
  (`scene-render-core.ts`, A3.3): the editor asks its layout worker for the
  keyed form (`form: 'keyed'`, answered `laid-out-keyed`), held by
  `editor-surface-core.browser.test.tsx` and the worker parity test. Previews
  and comment bodies still draw in TypeScript (A3.4 on).
- `core.search` (`search.ts`): lexical search over the one `search_op` export.
  Text calls are stateless; a `SearchIndex` (a corpus's token bags, upserted per
  changed document, queried by string) and a set of link labels live in the
  instance under a handle, released by `release()` or when collected. A lone
  surrogate is sent as U+FFFD (same unit count, same tokens and offsets). A
  call past a cap throws `CoreInputRefused`; no TypeScript answers in its place.
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

  No TypeScript answers either refusal in the core's place (ADR-0054 step 7 deleted the
  router and the layout): a refused routing call throws to the caller of canvas-render's
  `routeLayout`, and a refused layout is drawn as the refusal notice. For OKF and JSON Canvas: codec's
  `parseOkf`/`serializeOkf`/`parseSpatial`/`serializeSpatial` turn a decline into a read failure and
  a typed write refusal.

## What does NOT belong here

- Anything that imports canvas-render. A root hands canvas-render the core
  this package loads (`SpatialLayoutOptions.core`), so the dependency points
  from the roots to both, never from here to canvas-render. Its input types are
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
a job that lays out through the core uses that action.

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
- canvas-render's `canvas-render-rust` loads the oracle build from
  `target/dist-oracle`, not `artifacts/`; the shipped artifact is never
  asked for an export only a test calls.
- What the shim ROUTES is held to the frozen recording of the TypeScript
  composer's routing (`route_layout.f64`) by canvas-render's
  `recorded-oracle.test.ts`, which asks the shim's typed `routeLayout` over the
  shipped artifact; the TypeScript itself went in ADR-0054 step 7 (S18h3b).
