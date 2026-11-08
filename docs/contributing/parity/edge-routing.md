# Parity checklist: edge routing

The [QR-33a](../quality-requirements.md) checklist for the first ported module,
`packages/canvas-render/src/layout/edges` (Rust: `crates/core/edge-routing`,
one wasm export `edge_route_layout`, ABI 14, reached through
`@kamiazya/whiteboard-core-wasm`). It is filled in as the module stands, so a
row says what is shown, not what is intended. The switch
(`CoreImpl`, per ADR-0054 "Transition mechanics") is `differential` in the
daemon and the web editor under development and CI, and `ts` in a release. It
**may not move to `rust` until every row below is `met` or `n/a`**; rows 1 and 10 are still open and rows 11 and 14 are partly met, so today it may not.

Ports, in order: #2163 (grid-route spike), #2164 (geometry and ink), #2165
(edge-rules), #2166 (router leaves), #2167 (`routeEdge`), #2168 (anchor pass),
#2169 (coincident-ends repair), #2170 (crossing sweep), #2171 (side-choice
search), #2172 (layout/edges suites against Rust), #2173 (one call per
layout), #2174 (core-wasm shim), #2175 (`routeLayout` and the `CoreImpl`
switch in canvas-render), #2176 (daemon), #2177 (web editor).

## QR-33a

| # | Check | Status | Evidence, or what is missing |
|---|---|---|---|
| 1 | Contracts in `contracts/`, generated into both languages, `codegen --check` clean | not yet | `contracts/geometry` (`Point`, `Rect`) is generated into `crates/core/edge-routing/src/generated/geometry.rs` and checked by `tests/geometry_contract.rs`. The routing input and output are NOT contracts: they cross as flat `Float64Array`s, ADR-0054 decision 9's declared fast path (`routing_input.rs` says so), so there is no schema to generate. The deviation is declared by the ADR; the row stays open until the PR moving the switch states it as accepted. |
| 2 | Layer per the architecture map; dependencies equal the allowed set; core wasm imports nothing | met | `crates/architecture-map.json` declares `whiteboard-edge-routing` (core layer; allowed: `whiteboard-det`, `whiteboard-scene`, `serde`). The manifest depends on `serde` and `whiteboard-det` only, a subset. `cargo xtask arch-map` and the wasm32 import scan run in the `rust` job via `pnpm rust:check`. |
| 3 | Clippy, fmt and the core lint set pass with no new `#[expect]` outside a ledger | met | Workspace lints deny `unwrap`/`expect`/`panic` and bare `allow` (`Cargo.toml`), and `pnpm rust:check` passes. Every `#[expect(..., reason)]` in the workspace is counted per crate per lint in `crates/expect-ledger.json`, held from both sides by `tools/arch-lint/src/expect-ledger.test.ts` (a count above or below what the tree holds fails: an unlisted lint fails until listed with a reason, a stale count fails too). It counts, it does not list sites: a change that removes one `#[expect]` and adds another for the same lint in the same crate keeps the count and passes, so the site's own `reason` is what a reviewer reads there. Commit `test(arch-lint): a both-sided ledger of every Rust #[expect], per crate per lint`. |
| 4 | Native unit tests red-first; every QR-14a property class present through the shared prelude, with reachability floors, committed regressions, no pinned seed, each mutation-checked | met | **The prelude exists** (`crates/testing/proptest`, `whiteboard-proptest`): `check` runs a property for fast-check's 200 cases unless the call passes another budget; the seed is always `RngSeed::Random`; a failure's shrunk case is written beside the property as `<file>.proptest-regressions`, to be committed; `Floor` asserts how many draws reached the case a property is about. `deny.toml` admits proptest only through the prelude, and `tools/arch-lint/src/rust-proptest-prelude.test.ts` refuses a runner, config, `proptest!` or seed built anywhere else, and `PROPTEST_RNG_SEED` in a workflow or script. **One property is native**: `tests/grid_route_optimality.rs`, the twin of `grid-route.optimality.properties.test.ts`: on a lattice of boxes, a path `route_on_grid` returns costs exactly what an independent Dijkstra (a linear scan for the minimum, no heap, no heuristic) says the optimum is. It runs natively and on wasm32 under Node (`cargo xtask cross-target`: 50 tests on both), with a floor of 100 of its 150 draws routed with a bend (measured 131 to 133). Mutation-checked: a heuristic tripled (inadmissible) fails it with a 440 px route where 360 px is optimal. QR-14a's classes (parsers, state machines, stores, CRDTs, normalisations) mostly have no member in this crate, which is a pure function of boxes; `tests/detour_properties.rs` adds the twins of `detour-reach.properties.test.ts` (every detour waypoint within the ends and the region grown by `DETOUR_REACH_PX`; floor 250 of 300 draws with a waypoint outside the ends' own box, measured 295 to 297) and `straight-detour.properties.test.ts` (a corner detour crosses no block, or no body when escaping one, and turns only within reach; floor 100 of 400 routes with a turn, measured 139 to 170). Mutation-checked: the reach zeroed, one waypoint moved a pixel further out, and the corner search told nothing is in the way each fail. `tests/routing_budget_properties.rs` twins `routing-budget.properties.test.ts` over `route_layout`, the composer's one call: an account holding exactly what a layout spent lays it out unchanged and ends at zero, and the default account lays it out the same (floors 25 and 50 of 80 boards spending on the grid and pair accounts, measured 44 to 51 and 75 to 80); refusing an exact balance, in the trial and repair accounts or in the grid search, fails it. `tests/ink_properties.rs` twins `diagonal-ink.properties.test.ts`: `diagonal_ink_through` agrees with a sampled estimate (floor 40 of 150 paths with ink inside a rect, measured 70 to 85), moves with the board, and reads nothing off an axis-aligned path; a halved clip and counted axis segments each fail it. `tests/anchor_groups_properties.rs` twins `anchor-groups.properties.test.ts`: a one-edge re-side through `patch_anchor_groups` lands the partition `build_anchor_groups` rebuilds (floor 150 of 200 re-sides that change it, measured 183 to 188), and re-siding to the sides an edge has is the identity; skipping the touched groups' re-placement fails it. `tests/crossing_sweep_properties.rs` twins `edge-crossing-sweep.properties.test.ts`: `build_pairwise_scores` equals the O(E^2) scan over the shared narrow phase, both ways, on raw grid polylines with sub-quantum jitter (floors 25 overlapping and 1000 crossing pairs a run, measured 50 to 54 and 2049 to 2100) and on paths `route_layout` routed (floor 150 crossing pairs, measured 388 to 569), with shared corners counted by set intersection rather than the sweep's bucket walk; a budget covering the sweep changes nothing and one pair less refuses it. Skipping the shared corners, zeroing the broad-phase slack and refusing an exact balance each fail it; pruning a segment that only touches the slack boundary survives and is equivalent, since such segments lie half a pixel apart and score nothing. `tests/edge_rules_properties.rs` (16 tests) twins `edge-rules.properties.test.ts`: side-pair candidates are total and deterministic, the pair penalty lands on tiers 0 to 2 only, the self penalty is a pure tuple of counts with every self tier witnessed, border tracing and endpoint-body ink agree with oracles written from the definition (floors 13 and 24 of 200, measured 26 to 44 and 49 to 60; the strictly-interior chord is drawn once per path rather than once per point, since the TypeScript's shape reached a positive chord in only 1 to 10 of 200) and never charge one segment twice, path reversal agrees with a per-axis count and is invariant under translation and point order, and `has_repairable_problem` reads every tier but the last; 17 planted defects each fail it. Three TypeScript properties have no Rust subject: the preference rules are private functions with no rule-list parameter, so "reaches every candidate rule" and the two rule-removal properties cannot be stated. `tests/edge_routing_properties.rs` (10 tests) twins `edge-routing.properties.test.ts`: containers, orthogonal and curved routes, rounded flattening, the anchor fan-out, occlusion-aware sides, zero-bend alignment, stub lane depth, sweep-rank lanes and crossing minimisation; 9 of 10 fail their planted defect. The sweep-rank lanes property was VACUOUS for the defect it names (lane depth by list index instead of sweep rank), in the TypeScript as well as here: its spokes sat at x=2000, so every route's first elbow ran horizontally to the target and no lane run passed the node. Both generators now stand the spokes 150 to 300 px out, where the corridor turns at its lane, with a floor of 50 boards in 200 holding a lane run beside the hub (measured 106 to 115 TypeScript, 112 to 121 Rust, 0 at x=2000); the list-index mutation now fails both; `edge-jumps.properties.test.ts` has no Rust subject, since the line jumps are drawn after routing and are not in the ported layout. The recorded oracle (row 11) is an EXAMPLE corpus, not a property. |
| 5 | Every port implementation the module touches runs its conformance suite | n/a | The module touches no store or sync port; it is a pure function of boxes. |
| 6 | Layer 1: every TypeScript test and scoreboard passes against Rust, pinned numbers identical, no expectation edited | met | The `canvas-render-rust` project (`packages/canvas-render/vitest.rust.config.ts`) re-runs `src/layout/edges/**/*.test.ts` with `grid-route`, `edge-router` and `spatial-edges` aliased to wasm shims (#2172), including the routing scoreboard. Two files are excluded because they count TypeScript-internal work (`grid-route.cost.test.ts`, `spatial-edges.cost.test.ts`); their reasons are in the config, and the Rust search's budget accounts are compared exactly by `spatial-edges.rust.test.ts`. It runs in CI's `rust` job. |
| 7 | Layer 2: property differential with exact equality, shown to fail on a planted one-ulp change | met | Exact equality: `edge-*.rust.test.ts`, `route-layout.rust.test.ts` (compared position by position). Planted 2026-11-08 on the Rust side, wasm rebuilt for each, every file in `test-utils/wasm/` run alone. **An anchor coordinate** (`side_point_at`'s top-side x, `.next_up()`): `route-layout`, `coincident-ends`, `edge-anchors` (both properties) and `edge-primitives`' segment tests fail, each within 0.31 s of its first run; `spatial-edges` fails too but does not finish within 3 minutes, since shrinking a full-search board costs about 1.3 s a step (the same with and without the plant, measured natively on the captured board); the other seven files never reach the planted branch and pass. **A cost-only quantity** (`path_length`'s total, `.next_up()`): only `edge-primitives`, which compares the function's numbers directly, fails; every layout-level differential passes, because one ulp of length flips no comparison the search makes on the boards drawn. The differentials are exact on what is DRAWN; a difference that changes no route is visible only where the number itself is compared. |
| 8 | Layer 3: shared fixtures and goldens byte-identical natively and on wasm | met | `cargo xtask cross-target` runs every core crate's tests natively and on wasm32 under Node with the same count (#2162); the crate has the `wasm-bindgen-test` dev-dependency for it. |
| 9 | Every tolerated difference is a both-sided ledger entry | met (vacuously) | There are none: the differentials assert exact equality and no tolerance ledger exists for this module. `differential` mode reports any difference as a `CoreMismatch`. |
| 10 | `differential` has run in CI and in dogfooding with no unexplained mismatch | not yet | In CI: the daemon (#2176) and the web editor (#2177) set `differential` for dev and test, and `WHITEBOARD_CORE_MISMATCH=throw` makes a difference fail a test. In dogfooding: no recorded time. The stage needs "one release of differential data" (ADR-0054, stage 3), and no release has carried it. |
| 11 | `cargo mutants --in-diff` clean or ledgered; line and region coverage at or above the crate's floor | partly | **Coverage: met.** `cargo xtask coverage` (in `pnpm rust:check`, cargo-llvm-cov 0.9.1) holds each crate to `crates/coverage-floor.json`, failing under a floor and on a floor more than two points below the measurement. The edge crate's floor is 96 lines / 96 regions: first measured 94.47% / 94.57% with `crates/bindings/wasm/tests/recorded_oracle.rs`, against 71.37% / 69.20% from the crate's own tests alone, and 97.06% to 97.34% / 96.72% to 96.94% with the native properties (row 4). A generated board reached the coincident-ends repair only sometimes, which moved the crate by 2.8 points between runs and read as a stale floor on CI, so the repair has a fixed example of its own (`coincident_ends.rs`). **Mutation: measured, not yet gated.** cargo-mutants judges a mutant by the native tests, and the edge crate's oracle is the TypeScript, which only the wasm differentials reach; native tests alone caught 10 of 59 viable mutants in `edge_sides.rs`. So the TypeScript composer's answers to 309 layouts are recorded (`packages/canvas-render/src/test-utils/wasm/oracle/route_layout.f64`, held equal to today's TypeScript by `recorded-oracle.test.ts` in the node project), and the wasm crate replays them bit for bit in under a second. With it, `edge_sides.rs` is 59 of 59, and the whole crate (2026-11-08, `--test-workspace=true`): 2145 mutants, 1785 caught, 231 missed, 18 timed out, 111 unviable, so 88.5% of the judged mutants are caught. The missed cluster in `spatial_edges.rs` (39), `config_score.rs` and `coincident_ends.rs` (25 each), `straight_detour.rs` and `segment_intersection.rs` (22 each). **The PR gate exists:** CI's `rust-mutants` job runs `cargo mutants --in-diff` against the PR base in four shards after a green `cargo test --workspace`, and fails on a missed or timed-out mutant or a failed baseline; `.cargo/mutants.toml` ledgers the two plumbing surfaces no unit test can observe (xtask's entry point, the coverage command's process and file I/O), each with its reason, and the script fails a stale entry. On this change's own diff it judged 48 mutants and caught 48, after a first run caught 33 of 59 and the coverage command's logic was split out and tested. Open: the 231 survivors above are classified (real risk, equivalent, permissive) only as a diff reaches them, and a push to main is judged in-diff like a PR: the whole-workspace run (`pnpm rust:mutants:full`) is by hand, since it would fail every merge on those survivors until they are classified. |
| 12 | One call per user operation; boundary cost measured on browser, Node and workerd against the TypeScript, result in the PR body | met for the measurement, PR body owed | `edge_route_layout` is called once per `routeLayout`, which the composer calls once per layout; `scripts/route-layout-boundary.mjs` fails if the Rust loop makes any other number of wasm calls. Measured on all three runtimes, below. The PR that moves the switch pastes the table. |
| 13 | Artifact size within its ledger, peak memory reported, Workers budgets measured | met for the measurement | Size: `crates/wasm-size-ledger.json` ceiling 556495 bytes, 529996 measured (2026-11-08). Memory and budgets, measured 2026-11-08 by `scripts/route-layout-boundary.mjs` (which now reads the instance's linear memory after each board, times `coreFrom` and routes the largest board 20 more times): linear memory is 1.13 MiB after init and peaks at 4.06 MiB on the 165-edge board, the same on Node 24, Chromium 153 and workerd; 20 more layouts of that board leave it at 4.06 MiB, so repeated layouts reuse what the first grew and a long-lived tab does not creep. Startup (`coreFrom`, the module already compiled) is 1.4 ms on Node, 3.2 ms on Chromium and 3.0 ms on workerd, against the free plan's 1 s. CPU per request against the free plan's 10 ms, Rust on workerd per layout: the corpus 0.08 ms, the 2-5 node boards 0.33 ms, the stacked frames 1.5 ms, the lattice 2.7 ms, and OVER it from a single 38-edge board (33 ms) to the 165-edge one (63 ms); the TypeScript is over it on the same boards (34 and 75 ms). So a large board's routing is one call that cannot fit a free-plan request, and QR-22c's "splittable" is not met. Not done here, and each its own requirement: QR-22c's workerd job in CI (this is a local `workerd` binary, whose clock advances during synchronous work where a production Worker's does not), and QR-22d's `--max-memory` at link time and the per-artifact `opt-level` choice. |
| 14 | Every untrusted-input entry has caps and a fuzz target, seeded and run, no open crash | partly | What QR-28b also asks is NOT met: the TypeScript side does not read the registry; of the three caps only `maxBytes` is enforced by the export (`maxDepth` is a flat wire's constant, and `maxMillis` is measured and a fuzz timeout, not a limit the export applies); and a refusal is an empty answer the shim reports as `CoreInputRefused`, not a generated refusal code, with the TypeScript then answering an over-cap wire rather than refusing it. What is met: `crates/input-caps.json` has `whiteboard-wasm::spatial_edges::edge_route_layout`: maxBytes 262144 (the export refuses a longer wire, `MAX_WIRE_NUMBERS`; the largest corpus board's wire is 22984 bytes, so 11.4x), maxDepth 2, maxMillis 5000 (the slowest draw at the cap was 2.3 s on Node wasm, 920 nodes and 2065 edges, 251624 bytes). Fuzz target `edge_route_layout` (`crates/fuzz`) checks the answer's layout by an independent walk; seeds encoded from the routing corpus are in `crates/fuzz/seeds/edge_route_layout` (replayed, and required to be answered). The fuzzer found a real defect in minutes: a NaN node height made the side search's worst-offender ranking a comparator with no order, and std's sort panicked on it (an aborted instance on wasm). The TypeScript answers that board, so the fix is the port's sort, not a refusal: `trial_edges_for` sorts with `whiteboard-det`'s `js_sort_by`, whose path past 64 elements is now a merge sort that never panics. The crash input is committed under `regressions/` and replays in `rust:check`; putting std's sort back fails it. Only a non-finite budget account is refused, a budget being the layout's own allowance rather than a caller's geometry. |
| 15 | Logging through the `log` facade; `thiserror` convention; poison-and-recover covers held state | n/a | The crate neither logs nor returns errors (a refusal is the shim's `CoreInputRefused`, and `routeLayout` falls back to the TypeScript), and holds no state across calls; its budget is passed in and out per call. |
| 16 | `PORTED_FUNCTIONS` ledger lists the function; once `rust`, the TypeScript export re-exports the shim | met | `tools/arch-lint/src/ported-functions.ts` lists `routeLayout` at stage 2 with its TypeScript export, its `LayoutCore['impl']` switch key (set through `SpatialLayoutOptions.core`), the Rust export `edge_route_layout` and the shim member; `ported-functions.test.ts` fails a switch key the ledger omits, a listed function that no longer exists, and a stage-3 entry whose TypeScript still implements the function instead of re-exporting the shim. Commit `test(arch-lint): the PORTED_FUNCTIONS ledger, held from both sides`. |
| 17 | Any Unicode table comes from a pinned crate with a version-asserting test | n/a | The edge layer uses no Unicode tables. |
| 18 | Exit criteria (QR-33b) recorded in the PR | met here, repeat in the PR | Below. |
| 19 | Docs reflect the shipped state | met | ADR-0054 carries a dated status note (2026-11-08) and its Status line no longer says nothing is ported; the ADR index row and `quality-requirements.md`'s status paragraph state that edge routing is ported at stage 2 (`differential` in development and CI, `ts` in a release). The decisions are untouched. |

## QR-33b exit criteria

| Criterion | Recorded |
|---|---|
| Port shape | Structure-preserving. The Rust files follow the TypeScript modules one to one (`edge_router.rs` / `edge-router.ts`, `spatial_edges.rs` / `spatial-edges.ts`, ...), so a reviewer reads them side by side; `js_map.rs` exists to keep the TypeScript's `Map` iteration order. |
| TypeScript deletion deadline | The release after the one in which the switch first defaults to `rust`. No later date is requested. |
| Rollback | Set `WHITEBOARD_CORE` (daemon) or `VITE_WHITEBOARD_CORE` (web) back to `ts` or `differential`; the composition roots read it (`packages/mcp-server/src/server/export/layout-core.ts`, `apps/web/src/lib/spatial/layout-core-settings.ts`). While the TypeScript exists nothing else is needed; a core that throws already falls back to the TypeScript answer per call. |
| Freeze lift | `packages/canvas-render/src/layout/edges` is frozen for feature work until the switch is `rust` and the TypeScript is deleted; after that, features go to Rust only (ADR-0054 decision 23). |

## Boundary cost (QR-22b)

Instrument: `packages/canvas-render/src/test-utils/wasm/route-layout-boundary.ts`,
driven by `scripts/route-layout-boundary.mjs`
(`node packages/canvas-render/scripts/route-layout-boundary.mjs --rounds=15 --batch-ms=100`;
`--runtime=node,chromium,workerd`, `--workerd=<binary>`), with a thinner
`vitest bench --project "canvas-render-node (bench)" route-layout-boundary`
over the same boards for Node alone. It needs the staged artifact
(`pnpm rust:build:wasm`, then `pnpm --filter @kamiazya/whiteboard-core-wasm stage:wasm`).

How each side is known to be what it claims:

- The TypeScript side is `routeLayout(undefined, ...)` over the real modules in a
  bundle built with no alias. The `canvas-render-rust` vitest project aliases
  `./edge-router.js`, `./spatial-edges.js` and `./grid-route.js` to Rust shims,
  so a baseline taken there would be Rust twice; the bench project and the
  script bundle have no such alias.
- The wasm export is wrapped and counted. The harness throws if the TypeScript
  batches make any wasm call, or the Rust batches make other than one per
  layout. Planting the Rust core on the TypeScript side makes it throw
  (`240 counted wasm calls ... expected 120`).
- Before timing a board the harness routes it once in `differential` and throws
  on any mismatch, so no ratio is quoted for a port that answers differently.
- Rounds interleave the TypeScript batch, the Rust batch and a replay of the
  bare wasm call in a rotating order; each batch repeats the board until it is
  long enough for the runtime's clock. Numbers are milliseconds per iteration
  (every layout of the class once), median with [min-max] over 15 rounds.
- The boundary is `Rust total - wasm call`. The wasm call is the export replayed
  on the inputs the shim built, so it includes copying across and the routing;
  the remainder is encode, decode and the shim. It is a difference of two noisy
  medians and goes negative below the noise (about 1 ms on the big boards), so
  read it as "no larger than a few tenths of a millisecond" there, not as a
  value. The nodes-only row (144 nodes, no edges) is the direct fixed cost:
  about 0.01 ms.
- Chromium is 153 headless shell with a 100 microsecond clock; workerd is the
  local `workerd` binary (2026-11-08), whose clock here advances during
  synchronous work (a production Worker's does not, so these are engine
  numbers, not a Workers platform measurement).

Node v24.22.1, one machine, nothing else running by intent (load average 0.2 at the start):

| board (layouts / nodes / edges) | TypeScript | Rust | wasm call | Rust / TypeScript | boundary share |
|---|---|---|---|---|---|
| corpus, 5 reported boards (5/15/11) | 0.484 [0.440-0.877] | 0.307 [0.266-0.542] | 0.263 | 0.62 [0.54-0.70] | 16% [4-35] |
| synthetic, 30 boards (30/108/90) | 17.5 [17.0-19.8] | 9.44 [9.15-9.60] | 9.11 | 0.54 [0.48-0.55] | 3% [2-5] |
| clustered 3x8 (1/24/38) | 46.0 [42.8-47.3] | 30.4 [29.4-31.6] | 30.3 | 0.66 [0.63-0.74] | 0% [-3-3] |
| lattice, 12 boards (12/80/82) | 43.1 [40.8-58.8] | 27.4 [26.9-30.7] | 27.1 | 0.65 [0.48-0.71] | 1% [-3-12] |
| stacked frames, 12 boards (12/137/49) | 26.7 [24.7-33.2] | 16.9 [16.4-19.9] | 16.6 | 0.63 [0.56-0.68] | 1% [-50-17] |
| clustered 12x12 (1/144/165) | 88.2 [85.1-110.8] | 59.1 [58.2-61.3] | 58.7 | 0.67 [0.55-0.69] | 0% [-3-6] |
| clustered 12x12, no edges (1/144/0) | 0.015 | 0.018 | 0.004 | 1.18 [1.12-1.24] | 80% |

Chromium 153.0.8010.12:

| board | TypeScript | Rust | wasm call | Rust / TypeScript | boundary share |
|---|---|---|---|---|---|
| corpus | 0.395 [0.347-0.598] | 0.297 [0.269-0.539] | 0.255 | 0.77 [0.61-0.90] | 14% [4-18] |
| synthetic | 14.3 [13.1-20.2] | 8.98 [8.48-11.5] | 8.78 | 0.64 [0.45-0.71] | 1% [-54-15] |
| clustered 3x8 | 34.1 [33.2-41.9] | 29.5 [29.3-31.2] | 29.7 | 0.87 [0.74-0.89] | 0% [-13-1] |
| lattice | 32.8 [32.2-36.9] | 25.6 [24.3-32.3] | 25.4 | 0.78 [0.69-0.93] | 1% [-8-21] |
| stacked frames | 21.3 [20.5-22.9] | 16.0 [15.8-18.8] | 16.0 | 0.75 [0.71-0.88] | 1% [-22-17] |
| clustered 12x12 | 75.3 [71.5-94.0] | 58.9 [56.8-67.8] | 57.9 | 0.76 [0.63-0.90] | 0% [-10-13] |
| clustered 12x12, no edges | 0.011 | 0.017 | 0.002 | 1.68 [1.57-1.79] | 87% |

workerd (local binary, 300 ms batches, 15 rounds):

| board | TypeScript | Rust | wasm call | Rust / TypeScript | boundary share |
|---|---|---|---|---|---|
| corpus | 0.323 [0.295-0.430] | 0.270 [0.263-0.390] | 0.247 | 0.84 [0.66-0.96] | 10% [2-30] |
| synthetic | 13.4 [11.7-15.7] | 9.63 [9.11-11.3] | 9.37 | 0.75 [0.63-0.80] | 2% [-4-17] |
| clustered 3x8 | 33.6 [32.4-39.0] | 32.2 [31.8-36.5] | 32.4 | 0.97 [0.89-1.06] | 0% [-17-12] |
| lattice | 33.2 [30.6-36.1] | 27.8 [27.0-32.5] | 27.6 | 0.86 [0.77-0.95] | 1% [-2-14] |
| stacked frames | 20.9 [20.1-24.1] | 18.0 [17.4-21.0] | 18.0 | 0.85 [0.74-1.04] | 0% [-9-16] |
| clustered 12x12 | 71.0 [67.6-75.2] | 63.8 [61.0-70.2] | 64.4 | 0.90 [0.84-1.00] | 0% [-17-10] |
| clustered 12x12, no edges | 0.009 | 0.012 | 0.002 | 1.37 [1.13-1.62] | 80% |

Reading: with edges to route, the Rust path is faster than the TypeScript by median
on every runtime and board class (ratio 0.54-0.97; the narrowest is a 38-edge
board in workerd, whose range [0.89-1.06] crosses 1), and the marshalling is below what the method can
resolve on any board past the smallest. On the five reported corpus boards,
where a layout is about 0.1 ms, the boundary is the largest share (10-16%
median) and the Rust path is still ahead. The one place the boundary dominates
is a layout with nothing to route (a 144-node board with no edges: 0.012-0.018
ms against 0.009-0.015 ms), which is a 0.003-0.007 ms cost per layout.

Not measured: QR-22b also asks for JSON compared with serde-wasm-bindgen on this
payload. The boundary is typed arrays by ADR-0054 decision 9, so there is no
JSON path to compare; the row stays a recorded decision, not a measurement.
Production Workers (a frozen in-worker clock, the platform CPU limit) are not
measured.
