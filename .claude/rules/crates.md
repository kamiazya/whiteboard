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
| `whiteboard-edge-routing` | core | present | side choice, anchors, grid search, crossings, jumps, rounding; the line jumps' broad phase (`edge_jumps::grid`: `place`, a run filed at the level whose cell holds it, and `SegmentGrid`, the levels a run reaches, its cells there, its candidates and the work budget), held to the recorded `edge-jump-grid.jsonl`; and the hops over it (`edge_jumps::compute_edge_jumps`: runs, crossings, the segment carrying each, the hand-over to the earlier edge, spacing and the 64/4096 caps), held to `edge-jumps.jsonl` |
| `whiteboard-model` | core | present | the mdast subset a layout reads (`mdast`: plain flow and phrasing types), the annotation layer as a canvas reads it (`annotation`: a thread, its anchor and its messages as plain data, and the comment each thread projects to on a canvas, `canvas_comments_of`), the frontmatter value tree, and the OKF frontmatter types generated from `contracts/model` with their hand-written checks (`checks.rs`), which `whiteboard-codec` reads and writes, and the JSON reader (`json.rs`: `JSON.parse`'s reading, keys in written order, which `serde_json` is not) |
| `whiteboard-facet-engine` | core | present | the theme, icon and stencil asset shapes, generated from `contracts/facets/engine`, the plugin manifest types from `contracts/plugin`, and the matchers of their patterns; the interpreter of the contract dialect (`schema`: a contract file's definitions judge a payload as the generated Zod does, in path and code) and the registry over plugin manifests (`registry`: targets, asset refs, `validate_facet_write`, and the compat chain `resolve_facet_payload` over the migrations a host supplies by name, held to `compat.jsonl`) with a plugin loaded from its manifest, contracts and asset tables (`plugin::build`, `manifest::read`), and a facets bucket judged for a write with a workspace's stencil library composed beside the registry (`partition`, behind the wasm export `facet_bucket_check`); the derived form follows |
| `whiteboard-scene` | core | present | the scene vocabulary as types (every node kind, appearance, ink, legend, `NodeOutline`, `DecorationContext`) and the one contribution trait a second caller needs today, `NodeDecoration`; the other closure-taking contribution traits are deferred, and `Deserialize` exists only behind the `oracle` feature |
| `whiteboard-codec` | core | present | OKF Markdown, JSON Canvas and OCIF serialize and parse; today the frontmatter reader and writer, the OKF envelope and JSON Canvas, across the wasm boundary as `okf_parse` / `okf_serialize` and `json_canvas_parse` / `json_canvas_serialize` |
| `whiteboard-markdown` | core | present | CommonMark, GFM and math parsed to an mdast tree (`parse`, `parse_counting`), a vendored, trimmed copy of markdown-rs 1.0.0 (MIT, `LICENSE-markdown-rs`) with the HTML compiler, MDX, front matter, serde and logging dropped, its two panics fixed and its cost, depth and size bounded (`limits`: a refusal answers where a bound is passed); no shipped artifact links it yet |
| `whiteboard-search` | core | planned | tokenizer, BM25 ranking, snippets, searchable text |
| `whiteboard-plugin-visual` | core | present | the visual facets' payload types, generated from `contracts/facets/visual`, the matchers of their patterns, the colour check and the one-grapheme check (`unicode-segmentation`); the bundled plugin loaded from its files into a registry (`host.rs`, over the asset JSON the TypeScript package also reads); the silhouettes' outlines and content boxes (`render.rs`: `shape_outline`, `shape_content_box`) and the facet readers (`read.rs`: shape, text alignment, edges, stroke, theme, stencil, symbol, each over a facet bucket through the registry's compat chain, held to `facet-read.jsonl`); its one decoration, `StencilBadge`, a `NodeDecoration` over the stencil and symbol those readers answer; the plugin's other contributions follow |
| `whiteboard-canvas-render` | core | present | the SVG backend (`svg`: `render_scene_to_svg`, `render_scene_to_keyed_svg`) and what it reads (arrowheads, bounds, sketch ink, outlines), held to the recorded `svg.jsonl`; line breaking (`linebreak`: `segment_ends`, the strict pair walk over a generated table), held to the recorded `linebreak.jsonl`; the text primitives (`uax_segments`, `longest_fit`, `truncate`'s `fit_to_width`, `inline_junction`), held to `text-primitives.jsonl`; the theme layer (`theme`: palettes, the spatial theme's resolvers, the themed appearance of a token bundle, the markdown chrome), held to `theme.jsonl`; the AI-facing spatial digest (`scene_digest`: `scene_digest`, `SceneDigest::to_json`), held to the recorded `scene-digest.jsonl`; the font measurer (`font_measure`, over the in-house `sfnt` reader), held to `font-measure.jsonl`; the markdown typesetter (`typeset`: the inline layer and every block (paragraph, heading, rule, raw html, definition, display math, fenced code, blockquote, list with task boxes, table, and an embed paragraph over a document, a canvas, a pending target or a placeholder) and `select_markdown_section`; `typeset_mdast_blocks` is total), held to the recorded `typeset.jsonl`, `section.jsonl` and `fit.jsonl`; the node box (`node_box`: content bounds inscribed by a silhouette (`node_outline::outline_content_box`), padding and content width, the chrome with its sketch ink (`seed`), the label run, content placed in a node, above it and fitted to it, over the silhouette each node resolved to (`NodeOutlines`, filled by `resolve_node_outlines`) and the text placement its own facet names) and `translate_scene`, held to `node-box.jsonl`; the node readers (`node_content`) and `label_of`; what the composer draws for one node (`compose_node`: the text body with its content cache, the frame with its background, the link, the file node's picture, canvas, document body and facet card in rank order with `fit_body_in_node`, a body's canvas embed, the lock badge, the dispatch by kind and the decoration pass (`compose_decorations`) over a slice of `NodeDecoration` contributions, the visual plugin's by default, with the body parser, a reference's resolution, passage highlights and the expansion policy asked of the host), with `scale_scene`'s `fit_scene_into_box`, held to `compose-node.jsonl`; a silhouette's hit test and edge anchoring (`node_outline`: `outline_contains`, and `outline_entry_point`, a bisection over it that pulls a route's terminal onto the outline), held to `node-outline.jsonl`; the composer's edge pass (`compose_edges`: every edge and line routed in one `route_layout` call, weighed, inked and pulled onto its ends' silhouettes by `node_outline`'s `outline_entry_point`, the frame titles both passes avoid, and each label placed by `edge_label_placement`, reading the visual plugin's edge facets through its readers and computing the line jumps itself), held to `compose-edges.jsonl`; the composer's walk over a whole canvas (`compose_canvas`: `layout_spatial_canvas`, each canvas coloured by intent (`declared_colours`), drawn in the theme it settles from its own facets or its host's, its nodes in paint order (`paint_order_of`) with their decorations and its empty frames tinted, then its edges, recursing into a file node's or a body's embedded canvas itself; `layout_spatial_edges`, the edge suffix alone; `natural_node_content_size`), with the comments, proposals and legend asked of an `Overlays` seam, held to `compose-canvas.jsonl`; a comment bubble's placement (`comments::placement`: the candidates, the least-covered pick, the leader's end, the point of a polyline nearest a pin), held to `comment-placement.jsonl`; the overlays follow |
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
| `whiteboard-proptest` | tooling | present | the one proptest prelude: case budget, unseeded runner, regressions beside the property, reachability floor |
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
any other change skips them as a declared skip. The per-module layer-2 exports
(`det_*`, every `edge_*` but `edge_route_layout`) are TEST surface, exported only
under the `oracle-surface` cargo feature: no shipped artifact has them, and
`pnpm rust:build:wasm:oracle` (`cargo xtask dist wasm --oracle`, into
`target/dist-oracle`, reporting ABI `<n>+oracle-surface`) builds the one the
test lanes load. After both wasm builds the `rust`
job runs `canvas-render-rust` (QR-21 layer 2, against the oracle build): canvas-render's
`det-math.rust.test.ts` holds `det-math.ts` to `whiteboard-det` through the
wasm artifact, exact on every double, and fails on CI if the artifact is absent; the
`test-utils/wasm/*.rust.test.ts` beside it do the same for each edge module
ported so far (grid-route, the geometry and ink primitives, edge-rules, the
router's leaves, the router, the anchor pass, the coincident-ends repair, the crossing sweep, the side-choice search, and
`edge_route_layout`, the whole layout's routing in one call). The same
project re-runs every `layout/edges` suite, scoreboards included, with
`./grid-route.js`, `./edge-router.js` and `./spatial-edges.js` aliased to the
Rust ports through the wasm (QR-21 layer 1; those suites are included only when
the artifact exists), so the routing scoreboards judge the Rust side-choice
search, repair and router together; the two `*.cost.test.ts` files that count
TypeScript internals are excluded there, since under Rust they count nothing. Every target runs nightly
in `.github/workflows/rust-fuzz-nightly.yml`, whose cache entry the PR job
restores read-only. The OKF envelope's and the JSON Canvas codec's differentials went with their
TypeScript (owner decision q40): their suites run in `codec-node` against the
core itself, and the recorded oracles are replayed there. `ci-rust-jobs.test.ts` holds the jobs' tool versions,
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
  show the shape. A cap is ENFORCED by the export itself, not only declared:
  `edge_route_layout` refuses a wire over `MAX_WIRE_NUMBERS` and a
  non-finite budget account, and the shim then answers from the
  TypeScript. Non-finite GEOMETRY is answered, because the TypeScript
  answers it: a sort whose comparator a NaN can break goes through
  `whiteboard-det`'s `js_sort_by`, never std's `sort_by`, which may panic
  on a comparator that is not a total order. Each fuzz target's seeds
  live in `crates/fuzz/seeds/<target>`. The OKF exports enforce theirs the
  same way (`["refused", code]` past `maxBytes`), and the shim also refuses a
  text that is not well-formed UTF-16 and a document the wire does not
  carry; a root answers all of those from the TypeScript.
- **`#[expect]` is ledgered**: `crates/expect-ledger.json` names every
  `#[expect]` with its reason, and `tools/arch-lint`'s
  `expect-ledger.test.ts` holds it equal to the source from both sides.
- **Coverage floors** are `crates/coverage-floor.json` (QR-18), held by
  `cargo xtask coverage` in `rust:check`: one `cargo llvm-cov --workspace`
  run, counted per crate; under a floor fails, and so does a floor more than
  `headroomPoints` below the measurement (`--update` only raises).
- **Mutation gate** (QR-17): CI's `rust-mutants` job runs `pnpm
  rust:mutants:pr` — `cargo mutants --in-diff` against the PR base, eight
  shards, after a separate green `cargo test --workspace` — and a missed or
  timed-out mutant, or a failed baseline, fails it
  (`tools/checks/src/rust-mutants.mjs` reads the exit codes). A mutant no
  test can observe is ledgered in `.cargo/mutants.toml` with its reason above
  the entry; the script fails an entry that matches no mutant, and the entry
  count is pinned (`rust-mutants-ledger.mjs`, held by arch-lint). A push to
  main judges the merged change in-diff the same way; `rust:mutants:full`
  (the whole workspace) is run by hand until its survivors are classified.
  The vendored markdown parser's files are left out of the in-diff run alone,
  by `.cargo/mutants-pr-exclude.txt` passed as `--exclude`: a config
  `exclude_globs` applies to every run, so the full run would skip them too.
- **`whiteboard-markdown` is vendored code held to the workspace lints by
  the module, not by line**: `vendored/` carries markdown-rs's tokenizer,
  resolvers and tree builder under one `#![expect]` per lint that does not fit
  it (indexing, arithmetic, function length), each in the ledger with its
  reason, while the crate root, `limits` and the budget (`vendored/budget`) are
  this repository's own and are held to the core lints as written. A bound is
  a `Refusal`, never a degraded tree: a text past a size, depth, container,
  delimiter-run or fuel bound is refused whole and a root answers from the
  TypeScript, so no tree differs from the TypeScript's because a bound fell
  where it did. Every loop whose length follows the text charges the parse's
  fuel (96 units a byte, over the 69 the dearest ordinary shape spends): every
  resolver's walk over its events is charged where `resolve::call` dispatches it,
  and a nested scan or a pass over a text's bytes charges itself, each held by
  an exact figure in `crates/core/markdown/tests/fuel.rs`. So a
  quadratic text is bounded by construction, and the cost test reads the clock
  besides, because a loop that does not charge is invisible to the count (an
  edit map that scanned its entries per edit took 108 s over a 64 KB text of
  blank lines and spent as many units as a fast one). The pipeline's one
  round loop (subtokenization) is a literal-capped `for`. The upstream panics
  were two bugs in resolving events, fixed at the cause (the list resolver's
  item end, the setext resolver's chains of underlines); the tree builder is
  also total on a stream it does not expect, which only the fuzz target
  (`markdown_parse`) and the totality property can judge.
- **Properties go through `whiteboard-proptest`** (QR-14b/d/e,
  `crates/testing/proptest`), a dev-dependency only: `check(strategy, cases,
  test)` runs 200 cases unless the call passes another budget, never with a
  fixed seed, and writes a failure's shrunk case beside the property as
  `<file>.proptest-regressions` (committed); `Floor` asserts how many draws
  reached the case the property is about. `deny.toml` admits proptest only
  through it, and `rust-proptest-prelude.test.ts` refuses a runner, config,
  `proptest!` or seed built elsewhere. A property runs on wasm32 too, so it
  counts in `cross-target` like any test.
- **The facet engine's answers are recorded the same way**:
  `packages/facet-engine/src/oracle/contract-schemas.jsonl` (the engine contract's
  asset schemas and the plugin manifest, through their generated Zod) and
  `packages/plugin-visual/src/oracle/facet-write.jsonl` (the bundled registry's
  write path) are replayed by `crates/core/facet-engine/tests/schema_oracle.rs`
  and `crates/core/plugin-visual/tests/facet_write_oracle.rs`; a replaying test
  in each package asks today's TypeScript the recorded questions again, and
  `WHITEBOARD_RECORD_ORACLE=1` re-records. Held in path, code and order, not in
  message (q43; `docs/contributing/parity/facet-engine.md`).
- **The TypeScript's answers are recorded for native tests**:
  `packages/canvas-render/src/test-utils/wasm/oracle/route_layout.f64` is
  what the TypeScript composer answers to 309 layouts, replayed bit for bit
  by `crates/bindings/wasm/tests/recorded_oracle.rs`, so cargo-mutants and the coverage floor judge
  the edge crate by the same oracle as the wasm differentials.
  canvas-render's `recorded-oracle.test.ts` (node project, nothing aliased to
  Rust) fails when the recording no longer equals today's TypeScript;
  re-record with `WHITEBOARD_RECORD_ORACLE=1` after a deliberate routing
  change.
- **The SVG backend is held to two recordings**:
  `packages/canvas-render/src/oracle/svg.jsonl` (the goldens and the laid-out
  scenes, 179 records) and `svg-edge-cases.jsonl` (small scenes aimed at one
  rule each: an unusable option, a link's address, the filter budget) are what
  the TypeScript's `renderSceneToSvg` and `renderSceneToKeyedSvg` answered, and
  `crates/core/canvas-render/tests/svg_oracle.rs` and `svg_edge_cases.rs` replay
  both natively and on wasm32: every document, keyed root and keyed group byte
  for byte. A deliberate change to the backend's output re-records them and
  changes the Rust in the same increment. The caller-supplied `icons` and
  `shapes` tables of `SvgDocumentOptions` are not ported (the bundled visual
  plugin's are the Rust tables), and a non-finite coordinate is `NonFinite`
  where the TypeScript throws `RangeError`.
- **Line breaking is held to a recording and a generated table**:
  `crates/core/canvas-render/src/linebreak/table.rs` is written from
  `css-line-break`'s trie by `packages/canvas-render/scripts/gen-linebreak-table.mjs <table.rs>`
  (`tools/arch-lint`'s `linebreak-table-generated.test.ts` runs it with `--check`), and
  `src/oracle/linebreak.jsonl` holds the TypeScript's `uaxSegments` breaks for the small
  corpora and one digest per chunk of the large ones, which
  `crates/core/canvas-render/tests/linebreak_oracle.rs` regenerates from its `meta`
  record; `WHITEBOARD_RECORD_ORACLE=1` re-records it. The port's header lists the holes
  of the oracle it preserves.
- **The font measurer is held to the Node measurer's recording**:
  `packages/mcp-server/src/server/export/oracle/font-measure.jsonl` (recorded by
  `measure-text.oracle.test.ts`, which sits in mcp-server because the measurer is a
  composition root's and canvas-render may not import it) holds opentype.js over the
  vendored Roboto and `constantRatioMeasureText`; `crates/core/canvas-render/tests/font_measure_oracle.rs`
  replays it bit for bit, reading the faces itself. Each record's `class` says how far the
  TypeScript is a per-glyph sum: `exact` (bit for bit, opentype's 64-code-point segment sums
  included, with the joining table `segment-joins.json` held equal to the Rust one) and
  `substituted` by the face's GSUB `ccmp`, which the port does not run. That class is a
  tolerated gap held both ways: within 0.1 em, and a record the port reproduces exactly
  fails, so the entry cannot go stale. The faces are read by an in-house sfnt reader
  (`crates/core/canvas-render/src/sfnt/`: directory, head, hhea, maxp, hmtx and a cmap in
  formats 4 and 12, chosen as opentype.js chooses; no dependency, because the maintained
  crates carry unsafe or f32 and `ttf-parser` is unmaintained). It reads fonts users install, so it
  is an `input-caps.json` entry (`sfnt_parse`, seeds in `crates/fuzz/seeds/sfnt_parse`) and
  refuses a cmap whose segments or groups are not sorted and disjoint.
- **The spatial digest is held to a recording and written by hand**:
  `packages/canvas-render/src/oracle/scene-digest.jsonl` holds `sceneDigest`'s
  `JSON.stringify` text for the scenes of `svg.jsonl` (by id), for scenes written
  as specs, and for seeded boards regenerated from its `meta` record (one FNV digest
  per chunk); a digest past 3,000 characters is held as its length and FNV digest.
  `crates/core/canvas-render/tests/scene_digest_oracle.rs` replays it byte for byte,
  so `SceneDigest::to_json` is a hand-written writer, not serde's, whose key order
  and number text are its own. A grid the TypeScript throws `RangeError` for is
  `DigestError::InvalidGrid`. Reading a recorded scene needs `serde_json`'s
  `float_roundtrip` (its default parser is one ulp off on some doubles).
- **The theme layer is held to a recording**: `packages/canvas-render/src/oracle/theme.jsonl`
  holds what `createSpatialTheme`, `createThemedAppearance`, `paletteFromTokens` and
  `markdownTheme` answered over every bundled theme, token shapes they do not reach and a
  node-kind by colour matrix, each double as its IEEE bits, and
  `crates/core/canvas-render/tests/theme_oracle.rs` replays it; `WHITEBOARD_RECORD_ORACLE=1`
  re-records. Not ported: the layout's read of a canvas's `visual.theme/v0` facet (it waits for
  the composer). The TypeScript's module-level memo is a `ThemedAppearanceCache` per call site.
- **The BudouX phrase breaker is held to a recording and a generated model**:
  `crates/core/canvas-render/src/budoux/model.rs` is written by
  `packages/canvas-render/scripts/gen-budoux-model.mjs <out.rs>` from the
  vendored `ja-model.ts` (`--check` is `tools/arch-lint`'s byte-equality test),
  and `packages/canvas-render/src/oracle/budoux.jsonl` records what the vendored
  parser cut (hand-written corpora, one string aimed at each of the 1,678
  entries, per-prefix and seeded-stream digests); `crates/core/canvas-render/tests/budoux_oracle.rs`
  replays it natively and on wasm32. The model does not know surrogate pairs and
  may cut between their halves, as the TypeScript does.
- **The text primitives are held to one recording**:
  `src/oracle/text-primitives.jsonl` holds `uaxSegments`, `longestFittingCount` (with
  its probe sequence), `fitToWidth` (kept text, flags, widths as hex doubles and the
  length of every text it measured, through the fake measurer) and the inline
  junction (seeded operation sequences with each answer and the final position of
  every run), plus digests for the large corpora and for `Intl.Segmenter` against
  `unicode-segmentation`; `crates/core/canvas-render/tests/text_primitives_oracle.rs` replays it and
  `WHITEBOARD_RECORD_ORACLE=1` re-records it. A `&str` holds no lone surrogate, so
  those answers are recorded for `uaxSegments` only.
- **The markdown typesetter is held to a recording and asks its host through a trait**:
  `packages/canvas-render/src/oracle/typeset.jsonl` holds, per input, the model tree, the width and
  theme, the answers of every host seam the input can reach (`InlineSeams`: emoji and icon
  shortcodes, document titles, embed names, a picture's source; their TypeScript is the plugin's and
  the keeper's, neither in Rust) and what `typesetMdastBlocks` laid out: the scene as `dumpScene`
  text (every double as 16 hex digits) or, for the large sets, its length and FNV digest, and how
  many times it asked the measurer, which pins the width search's probe sequence.
  `crates/core/canvas-render/tests/typeset_oracle.rs` replays it exactly, writing a Rust scene with
  a test-only dumper (`crates/core/canvas-render/tests/typeset_support`); `WHITEBOARD_RECORD_ORACLE=1` re-records. The
  corpora are read at record time only (the markdown oracle's parsed bodies, the wrapping
  corpus, hand-written cases, a seeded generator whose seed rides the `meta` record). A NaN is held as the positive quiet NaN on both sides, since its sign is the engine's choice. A list item and a table cell store their children relative to themselves (the backend translates by the wrapper's `bbox.x`), which the dump holds exactly; `scene_walk` already reads that set and the typesetter adds no third wrapper. The embed target tables ride each record: the documents a tree embeds, and in turn theirs. The nested-layout account is the typesetter's own (`NestedLayoutBudget`: 128 layouts, 4,000 canvas elements). `typeset.jsonl` writes each distinct set of host answers once, as a `seams` line the records name by key. `fit.jsonl` holds laid-out bodies as data with what `fitBlocksToHeight` and `firstLineOfBlocks` keep of each at every height (the edge of every block, a hair either side, NaN, negative, infinite), as a digest and the two signals, and as text for the scenes written by hand; `markLastRun` reads only `runs`, `children` and `items`, so a body ending in a table is cut but left unmarked, which the recording holds. `section.jsonl` records, per document and fragment, which blocks `selectMarkdownSection` keeps.
  BudouX reads UTF-16 units and can name a boundary inside a surrogate pair; neither side
  takes one (the TypeScript's `withoutPairCuts`, Rust's `splits_pair`), so no run holds half
  a character.
- **The markdown parser is held to `parseMarkdownBody`'s model tree**:
  `packages/codec/src/markdown/oracle/mdast.jsonl` records the digest of each
  document's canonical tree (the trees too for the spec and dialect sets), over
  frozen repository text, the CommonMark and GFM examples and seeded hostile
  text; `crates/core/markdown/tests/mdast_oracle.rs` replays it exactly except
  for `mdast_tolerated.json`, a shrink-only ledger (a differing case not in it
  fails, and so does a listed one that no longer differs; the count is pinned).
  An input past a bound is refused by Rust and not compared (`b<N>` ids).
  `codec-node`'s `mdast-recorded-oracle.test.ts` fails when the TypeScript
  stops answering as recorded.
- **What is ported is ledgered**: `tools/arch-lint/src/ported-functions.ts`
  (`PORTED_FUNCTIONS`) maps each ported TypeScript function to its Rust
  port and differential (QR-33a item 16).
- **Tooling may depend on bindings** (`crates/architecture-map.json`): a
  fuzz target drives an export through the same decode a host reaches.
- **Dependencies**: `deny.toml` keeps sources crates.io-only and bans
  `serde_json`'s `unbounded_depth` and `arbitrary_precision`; a third-party
  crate is allowed per crate in the map with its review as the reason.
  `serde_json` ships in `whiteboard-wasm` (the OKF document wire), so it is
  no longer xtask-only.
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
  scenario and fails until the wasm shim package, `core-wasm`, gains the recovery module it names); the native
  daemon builds with `panic = "unwind"` and `catch_unwind` per request, so
  one request fails rather than the process.

The TypeScript guards reach `.rs` too (`tools/arch-lint`: the file and
function size budgets, vocabulary, the comment guards through a Rust comment
lexer; `.claude/rules/tool-arch-lint.md`). Adding a crate means: a row in
`architecture-map.json`, a row here, and — once it has a manifest — nothing
else, because the map and the workspace are checked against each other.
