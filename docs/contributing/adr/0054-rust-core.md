# ADR-0054: The core moves to Rust — one pure core for wasm and native, with the TypeScript implementation as its oracle until it is deleted

**Status:** Accepted, decided by the owner on 2026-11-06. The workspace
skeleton and the Rust gates are in place, and the first module, edge routing,
is ported (the status note below); the migration order below is the plan. The development quality bar the
migration is held to is a separate, language-neutral document,
[Development quality requirements](../quality-requirements.md), which this
ADR cites by requirement number (QR-n). Amends
[ADR-0052](0052-edge-keeper.md) in one respect: the edge keeper is built in
Rust on workers-rs, not as a TypeScript composition root (decision 6).

**Correction note (2026-11-06, the skeleton and its gates landed).** Three
details below read differently from what shipped, and the record keeps the
original words with this note beside them: the `unsafe` ledger is counted by
`cargo xtask unsafe-ledger`, a lexer over each dependency's source, not by
cargo-geiger (decision 11); the hardening check reports the stack protector
and requires it only for a binary containing C or C++, since stable rustc
cannot emit one for Rust (owner decision; QR-28d); and CI selects the Rust
jobs by PATH (`PATH_JOBS` in `tools/checks/src/affected.mjs`) rather than
through `cargo metadata` (decision 10) — the per-crate graph is the next
cut once there is more than one crate worth distinguishing.

**Status note (2026-11-08, the first module is ported).** Edge routing
(`packages/canvas-render/src/layout/edges`, Rust in `crates/core/edge-routing`,
one wasm export `edge_route_layout` reached through
`@kamiazya/whiteboard-core-wasm`) is at stage 2, `differential`, in the daemon
and the web editor under development and in CI, and `ts` in a release. It is
listed in the `PORTED_FUNCTIONS` ledger (`tools/arch-lint/src/ported-functions.ts`).
The switch may not move to `rust` until every row of its parity checklist,
[parity/edge-routing.md](../parity/edge-routing.md), is met or not applicable.
The decisions below are unchanged.

## Context

**Everything except the UI is TypeScript today, and it already runs in three
runtimes.** The shared layer — `model`, `codec`, `canvas-render`, `search`,
`loro-adapter`, `server-core` and the rest of the architecture map's
`SHARED_LAYER_PACKAGES` — runs unchanged on Node, in the browser and on
Cloudflare Workers, and `tools/arch-lint` holds it to that by scanning for
`node:*`, DOM globals and `inversify`. The daemon is a Node composition root
(`packages/mcp-server`), published as `@kamiazya/whiteboard-mcp` and started
with `npx`, so installing it requires Node.

**Why now.** Four forces meet at this point and none of them is a
performance measurement — this ADR claims no speed-up; the routing spike is
the first instrument (see "Migration order"):

1. **The specification is stabilising.** Ten UI/UX waves have settled the
   document model, the facet system ([ADR-0013](0013-facet-system.md)), the
   render theme ([ADR-0030](0030-render-theme.md)), the proposal layer
   ([ADR-0029](0029-proposal-layer.md)) and the tool surface
   ([ADR-0031](0031-tool-surface-criteria.md)). A port of a moving
   specification ports the movement twice; a port of a stable one ports it
   once.
2. **The project is pre-release.** Every workspace package except one is
   private, and the one that publishes is `0.0.x` with no users. The
   vocabulary rule already treats stored and published shapes as free to
   change. The cost of a language change will never be lower than now.
3. **The CRDT is already Rust.** `loro-crdt` on npm is the Rust `loro`
   crate compiled to wasm. Today a TypeScript layer drives a Rust engine
   across a wasm boundary; in the end state the engine and the code that
   drives it share one language and one memory.
4. **The guarantees the project sells are determinism guarantees.** The
   canvas renderer's headline property is byte-identical SVG on every
   runtime, and `svg/determinism.test.ts` asserts it from Node and the
   browser. Today that holds because the JS engines happen to agree, and
   text measurement differs per runtime by construction (Canvas API in the
   browser, a font-table reader on Node). One compiled core, with
   measurement inside it, makes the property structural instead of observed.

Two runtime constraints shape the decision rather than motivate it: a Worker
runs within a startup budget (1 s), a per-request CPU budget (10 ms on the free
plan) and an isolate memory limit that includes the wasm, and the daemon
should not require a Node install (decision 5). Cloudflare's script-size
limits are to be verified from its own documentation before the worker
binding is built, because the sources consulted conflict (decision 22).

## Decision

### The decisions

Each decision is the owner's (decisions 1–25, 2026-11-06). Under each, the
alternatives that were weighed and why they lost.

#### 1. Two targets: wasm (browser, Workers, Node) and native (the daemon)

The core is pure Rust; bindings are separate crates. The first build is wasm
only, but the crate graph is shaped for both from the start.

| Alternative | Why rejected |
|---|---|
| Wasm only, the daemon hosting wasm inside Node | Keeps the Node requirement decision 5 removes, and puts every store call across a wasm boundary in the one process that has no reason to have one |
| Native only, with a TypeScript browser path | The browser and Workers would keep a second implementation of everything, which is the state this ADR exists to end |
| `no_std` core | Costs every allocator-using crate a feature flag and buys nothing the wasm import scan (QR-11) does not already prove: a core wasm that imports nothing cannot reach the OS, whatever `std` it was compiled against |
| napi-rs in-process addon for Node | Only worth it if an in-process Node path is ever needed; the daemon is a binary, not a library loaded by Node |

#### 2. Horizon: everything except the React UI

Layout, routing, tidy and scoring; model validation; the OKF / JSON Canvas /
OCIF codec; search; document operations; the `/api/v1` routes and the MCP
tools. React (`apps/web`, `facet-ui`, `plugin-visual/ui`, the React half of
`canvas-viewer`, `apps/extension`) stays TypeScript.

| Alternative | Why rejected |
|---|---|
| Port the hot path only (layout and routing) | Leaves two implementations of `model` and `codec` forever, and a chatty boundary between a Rust layout and a TypeScript model on every call |
| Port the UI too (a Rust UI framework) | No measured problem in the UI; React and its ecosystem are what the UI is built from |

#### 3. Contracts: one neutral schema generates both Zod and Rust

The source of truth for every cross-process contract becomes JSON Schema
files in the repository, in a restricted dialect (see "Seams", 8). A
generator emits Zod SOURCE for TypeScript and serde types for Rust; both
outputs are checked in, and CI fails on drift (QR-6). `z.infer` stays the
TypeScript type, so the Zod discipline in AGENTS.md is unchanged for its
readers — only the place the schema is written moves.

| Alternative | Why rejected |
|---|---|
| Keep Zod as the source, emit JSON Schema from it | Zod's `toJSONSchema` drops refinements silently, so the Rust side would validate less than the TypeScript side with nothing failing. Kept as a ONE-TIME bootstrap to seed the neutral files |
| Rust as the source (schemars, then Zod) | No mature Rust-to-Zod path (specta-zod is 0.0.0) |
| `z.fromJSONSchema` at runtime | Experimental, and runtime-only: there is no `z.infer`, so TypeScript would lose its types |
| `json-schema-to-zod` | Archived 2026-06-30 |
| `tsify` (types derived from Rust) | A second type source beside the schema, which is the drift this decision removes |

#### 4. The TypeScript implementation is the oracle, then it is deleted

During the migration the TypeScript implementation of each function is the
differential oracle for its Rust port. It is deleted once the port has met
the parity checklist (QR-33), not kept as a fallback.

| Alternative | Why rejected |
|---|---|
| Keep both implementations | Every bug fixed twice, and a permanent differential harness with nothing left to learn from it |
| Delete each TypeScript module as soon as its port compiles | No oracle: the existing suites and scoreboards are the only independent statement of what the code must do |
| A frozen copy of the old code as the oracle | The repo already uses this pattern (`argv.differential.test.ts`), and the live TypeScript module IS that frozen copy, given the freeze (decision 9) |

#### 5. Distribution: npm with per-OS native binaries

The daemon ships as `@kamiazya/whiteboard-mcp` with the same package name and
`npx` entry, plus one `@kamiazya/whiteboard-mcp-<os>-<arch>` package per
platform in `optionalDependencies` and a thin launcher that resolves it with
`require.resolve` and fails clearly when it is absent — the pattern biome and
esbuild use. Node is then needed only by `npx` itself, not by the daemon.
Plain binaries are attached to GitHub releases from the first release; Linux
binaries are static musl.

| Alternative | Why rejected |
|---|---|
| `postinstall` download | Broken under custom registries, proxies, offline installs and `--ignore-scripts`; pnpm 10 blocks lifecycle scripts; esbuild abandoned it for these reasons |
| cargo-dist's npm installer | Downloads after install, so the same failure set. Fine for GitHub releases, shell installers and Homebrew |
| A new package name | Breaks every existing `npx` registration for no gain |
| Dynamically linked glibc binaries | One more axis (`libc` per Linux package) for no user benefit; static musl runs everywhere |

#### 6. Workers: all Rust on workers-rs, routes included

The edge keeper ([ADR-0052](0052-edge-keeper.md)) is a workers-rs binding of
the same core, ops and HTTP adapter the daemon uses. This replaces ADR-0052's
plan of a TypeScript composition root over `createServer(deps)`; that ADR's
tenancy, access and licensing decisions stand.

| Alternative | Why rejected |
|---|---|
| A TypeScript Worker over the wasm core | Two route implementations (Hono on Workers, axum natively) for one API, each needing its own differential |
| Rust core on Workers, MCP in TypeScript | Same duplication for the tool table; and the MCP dispatcher is ops data (Seams, 4) either way |

MCP over HTTP on Workers depends on an `rmcp`-on-wasm spike (its
Streamable HTTP service assumes tokio); until it succeeds, the in-house
dispatcher is the plan.

#### 7. Mutation and coverage are merge gates on the Rust side

`cargo-mutants` and `cargo-llvm-cov` block a merge for Rust code: every
mutant in the diff is caught or ledgered with a reason, and coverage stays
above its ratcheted floor. This is stricter than the TypeScript bar, where
Stryker and coverage are report-only; QR-17 records why the asymmetry is
deliberate.

| Alternative | Why rejected |
|---|---|
| Report-only, as for TypeScript | The TypeScript reasons — a whole-suite score charged to whoever pushed last, per-test coverage letting killing tests escape, multi-hour lanes — are answered by a diff-scoped gate over a test-first codebase (decision 14) |
| Branch coverage as the gate | Nightly-only and unstable in rustc; MC/DC was removed from rustc in 2025. Branch is reported; mutants carry decision quality |

#### 8. This step's scope

This step delivers: the requirements document, this ADR, the module
partition, an empty cargo workspace skeleton, the Rust CI gates, the
neutral-schema pipeline end to end on ONE small contract (the geometry
vocabulary: `Point`, `Rect`, `Side`, `EdgeRoutingStyle`), and the
differential harness; of these, the schema pipeline and the harness are
still to come and land as the first crates do. The routing spike follows
them. The full target crate
graph is declared in the neutral architecture map with status `planned`;
only `det`, `log`, `edge-routing` (empty), `bindings/wasm` (exporting
`abi_version()`) and `xtask` are materialised.

The owner's stated intent applies to this and every later step: not YAGNI —
reason backward from the end state, and fix the seams now that would be
expensive to move later.

#### 9. Sequencing: freeze, then migrate bottom-up at full pace

The four wave-11 lanes finish and wave 11 merges. Then the UI/UX loop stops
and feature and specification changes in `packages/*` freeze (see "Freeze
policy"). Modules migrate bottom-up, one at a time — build in Rust,
differential against TypeScript, pass the gates, switch, delete the
TypeScript — at full pace, with no big-bang cutover.

| Alternative | Why rejected |
|---|---|
| Big-bang rewrite and cutover | No oracle on the day it matters, and nothing ships until everything does |
| Keep shipping features during the migration | The oracle moves under the port; every feature is written twice or the differential reports a difference nobody can attribute |

#### 10. The first foundation item is scope-aware CI

Before any crate lands: CI selects jobs by the affected set computed from the
workspace graph, fails closed when it cannot compute one, runs everything on
`main`, gates steps rather than whole jobs where that is cheaper, and
`ci-gate` treats a scope-skipped job as a declared skip, not a missing
result. The selection must extend to cargo crates through `cargo metadata`.
Coexistence roughly doubles the lanes a ported module touches (QR-32), and
without scope every PR pays for both languages. Issues found along the way
are fixed as they are found.

#### 11. Oracle strictness: byte-identical

Rust output must be byte-identical to the TypeScript oracle — SVG,
`sceneDigest`, serialised documents, routed paths. To make that achievable,
a TypeScript PRECURSOR lands first:

- det-math: every `Math.hypot` becomes `sqrt(dx*dx + dy*dy)`, and `sin`/`cos`
  go through an fdlibm port identical in both languages;
- ECMAScript number formatting: the `toFixed` tie rule and `Number#toString`
  (ryu-js on the Rust side);
- total comparators with a written NaN policy;
- ordered maps wherever iteration order reaches output.

Goldens and scoreboards may move ONCE, at the precursor, with reasons. After
that every exception is a ledger entry, one at a time.

| Alternative | Why rejected |
|---|---|
| A global epsilon | Hides exactly the one-ulp differences that flip a tie-break in routing and so change a discrete output; an epsilon on coordinates says nothing about which path was chosen |
| Change the digest at cutover | Moves every golden at the moment the oracle is being retired, so the difference cannot be attributed to either side |

#### 12. Plugins: compiled in, plus a declarative manifest

The bundled `visual` plugin is compiled into Rust as an ordinary implementer
of the contribution traits. A DECLARATIVE manifest path is designed now:
facet schemas in the neutral dialect, themes, shapes, icons, declarative
decorations and migrations. Its schema is
`contracts/plugin-manifest.json`.

| Alternative | Why rejected |
|---|---|
| Wasm component plugins | jco's browser support is experimental, and a component ABI is a second public surface to version |
| JavaScript plugins at runtime | Would re-introduce a TypeScript implementation of the contribution points inside the core's hot path |

#### 13. loro: bump first, then lock-step

`loro-crdt` on npm moves from 1.13.6 to 1.17.x first, verified by the
current suites. From then on the npm and Rust versions move in lock-step,
pinned `=`, with a guard test comparing the two lockfiles.

| Alternative | Why rejected |
|---|---|
| Different versions per side | The data format is compatible since 0.16, but 1.16.4 fixed an old version importing a newer one's unknown container types: old-reads-new is a real edge, and a skew makes every differential failure ambiguous |
| Bump at the end of the migration | The cohort migration (Seams, 6) would then compare two engine versions at once |

#### 14. Mutation gate shape

On a PR, `cargo mutants --in-diff` against the base: survivors are zero or
ledgered with a reason. On `main`, a full nightly run is reported, not
gated.

| Alternative | Why rejected |
|---|---|
| A full-crate run per PR | Too slow to gate on, and charges the author for mutants in code they did not touch |
| Diff-scoped only, no full run | `--in-diff` is not a substitute for a full run: a test deleted elsewhere can expose code no diff touches |

#### 15. Fuzzing is its own pillar

Every untrusted-input entry gets a fuzz target: the OKF, JSON Canvas and OCIF
parsers, sync frames, HTTP request bodies and MCP JSON-RPC, loro import, JSON
crossing the wasm boundary, and font files. Corpora are seeded from the
TypeScript fixtures, the scoreboard corpora and the property counterexamples;
every crash becomes a committed regression test; fuzz coverage is tracked. On
a PR the targets whose entry the diff reaches run for tens of seconds and a
crash blocks the merge; nightly, every target runs long, the corpus grows, and
the result is reported (QR-29a–QR-29e).

| Alternative | Why rejected |
|---|---|
| Fuzzing as a scheduled complement to the property tests | A property searches only the domain its generator was written for; hostile input is exactly what nobody wrote a generator for, so the two answer different questions |
| Scheduled only, never on a PR | A crash introduced by a PR would reach `main` and be found a night later, by someone else |
| Parsers only | The sync-frame, JSON-RPC, wasm-boundary, loro and font entries take untrusted bytes too, and the daemon serves them |

#### 16. Rust hardening gates

Merge and release gates, not advice (QR-28a–QR-28g):

- panic and arithmetic lints — no `unwrap`, `expect` or `panic!` in
  production code; `indexing_slicing` and `arithmetic_side_effects`
  restricted; `overflow-checks = true` in release;
- per-entry input caps — size, recursion depth, time — declared for every
  untrusted-input entry and checked by a guard;
- dependency safety — the cargo-deny gate plus a shrink-only ledger of the
  `unsafe` the dependency tree carries (cargo-geiger counts);
- binary hardening checked before release — PIE, RELRO, stack protector,
  stripped;
- a reproducible build — built twice, byte-equal — as a release gate;
- AddressSanitizer and UndefinedBehaviorSanitizer with the fuzzers, on a
  pinned nightly toolchain;
- `unsafe` forbidden; an exemption needs Miri.

| Alternative | Why rejected |
|---|---|
| Rely on safe Rust alone | Safe Rust still panics, wraps integers in release builds by default, recurses without bound, and inherits whatever `unsafe` its dependencies carry; the daemon is a long-running process on a user's machine |
| Hardening as a report | A mitigation that can silently go missing from a release is not a mitigation anyone can rely on |
| Reproducibility checked later | Retro-fitting it means finding every embedded path and timestamp at once; checked from the first release, each one is found by the change that introduced it |

#### 17. Provenance now, OS code signing when certificates exist

From the first release: SLSA build provenance for binaries and wasm
artifacts, `npm publish --provenance` for every package, and published
checksums (QR-27b). macOS signing with notarization and Windows Authenticode
are scaffolded in the release workflow now and enabled once the owner
provides certificates; until then the release says its binaries are
unsigned.

| Alternative | Why rejected |
|---|---|
| Wait for certificates before releasing binaries | Provenance and checksums already let a user verify what they install, and they cost no certificate |
| Add signing when certificates arrive, from scratch | Scaffolding it now keeps the release workflow's shape stable, and a test can hold that the steps exist and report when they are skipped |

#### 18. Security baseline: every technically solvable OpenSSF item

Every OpenSSF guideline item that is technically solvable is met — the
Scorecard checks, OSPS Baseline levels 1–3, the Best Practices badge
criteria, the Concise Guide, the npm and SCM best practices — and the bar is
set with SLSA v1, NIST SSDF (SP 800-218), CISA Secure by Design and ANSSI's
secure Rust guidelines as well. The control-by-control matrix, with each
control's evidence and regression guard, is the security baseline document
(`docs/contributing/security-baseline.md`); items only the owner can action
(account settings, certificates) are listed there as such.

| Alternative | Why rejected |
|---|---|
| Aim for the badge or the Scorecard number | A score can be raised without meeting the control behind it; the controls are the point |
| OpenSSF alone | It is silent on secure-development process (SSDF), on memory-safety posture (Secure by Design) and on Rust-specific rules (ANSSI) |

#### 19. The daemon stays a native Rust binary

Reconsidered against the counter-example of a project that moved its Rust
engine back out of a per-OS native binary (its cost was cross-language
serialisation on a chatty boundary, plus the binary's distribution), and
confirmed: the daemon owns its whole process, so it has no per-call boundary
to pay. Its distribution is fixed now (QR-27c): fixed package names and
platform set (linux x64/arm64 × glibc/musl, darwin x64/arm64, win32
x64/arm64), a launcher that checks the binary's version equals its own, npm
trusted publishing (OIDC) per package, and an install smoke under npm, pnpm
and yarn with `--ignore-scripts` and `--omit=optional`.

| Alternative | Why rejected |
|---|---|
| A Node daemon hosting the wasm core | Puts a wasm boundary inside every store call of the one process that has no reason for one, and keeps the Node requirement |
| Defer the platform matrix | npm's lockfile has skipped platform packages and installed both libcs in the past; the names and the set are cheap to fix now and expensive to rename after users install them |

#### 20. Panic policy: prevent by lint, recover by recreate-and-rehydrate

Panics are prevented by lints in production code (decision 16); this is the
safety net. The stable toolchain everywhere. Wasm artifacts use
`panic = "abort"`: a panic DISCARDS the instance, and the shim creates a new
one and REHYDRATES it from persisted state, tested in CI by a scenario that
poisons an instance and shows the next operation succeeding. The native
daemon builds with `panic = "unwind"` in its OWN release profile and catches a
panic at the request boundary (`catch_unwind` around the request's handler):
that request fails with a refusal (500), and the daemon keeps serving
(QR-26c). The skeleton's workspace-wide `[profile.release]` sets
`panic = "abort"`; it MUST be split per artifact when the daemon binding
lands, so that the wasm artifacts keep `abort` and the daemon alone unwinds.

| Alternative | Why rejected |
|---|---|
| `panic = "unwind"` in wasm (WebAssembly exception handling, the default in workers-rs 0.6) | Keeps the instance usable, but on `wasm32-unknown-unknown` for the browser and Node it still needs nightly `-Zbuild-std`, and every export would have to be `extern "C-unwind"`; one panic model for every wasm target is simpler to test. Revisit when it is stable |
| Recreate without rehydrating | Loses whatever the instance held — once the `LoroDoc` lives in the wasm, that is the open document |
| Abort the native daemon | One malformed request would take down every client's session |

#### 21. Browser support policy and an explicit wasm baseline

Until general availability: the latest browser versions only. At GA the
supported set is frozen as of that date, then moves gradually to the last
~2 years of major browsers. The wasm target-feature baseline is explicit
(`-Ctarget-feature`), pinned with the toolchain and `wasm-bindgen` as one
unit, and documented with an engine-support matrix updated per this policy
(QR-5a, QR-5b).

| Alternative | Why rejected |
|---|---|
| The compiler's default target features | They change across Rust versions (multivalue, reference-types, bulk-memory and nontrapping-fptoint were turned on by default), so a toolchain bump would silently drop engines |
| A long support window from the start | Pre-release, it would constrain the baseline for users who do not exist yet |

#### 22. Workers: design to the free plan

The free plan's budgets — 10 ms CPU per request, 1 s startup, the isolate
memory limit — are performance goals, measured in CI and reported (QR-22c).
Heavy work, such as a large board's layout, is designed to be splittable.
The paid plan is adopted only when a measured technical limit is hit. Size
limits are verified from Cloudflare's documentation before implementation:
the sources disagree (compressed limits reported removed on 2026-09-04,
against a 3 MB free-plan limit).

| Alternative | Why rejected |
|---|---|
| Design to the paid plan | Hides the cost of a design that only fits a 30 s budget, and makes a personal workspace cost money by default |

#### 23. The freeze lifts per module

A module's freeze lifts once its switch is `rust` and its TypeScript
implementation is deleted; from then on, new features for that module go to
Rust.

| Alternative | Why rejected |
|---|---|
| Lift the freeze only when the whole migration ends | Holds back product work on modules that have nothing left to be compared against |
| Lift it at the switch, before deletion | Features would then be written twice, or the oracle would fall behind the code it still guards |

#### 24. Coverage floors

Per crate, the floor starts at the first measured value rounded down, only
goes up, and is lowered only with a ledgered reason. Decision quality is the
mutation gate's job, not coverage's (QR-18).

| Alternative | Why rejected |
|---|---|
| One repository-wide threshold | Either too low for the core or unreachable for a binding; a per-crate floor is honest about each |
| A fixed target (say 80%) | A number chosen before measuring is either free or arbitrary; the ratchet makes every crate at least as tested as it was |

#### 25. YAML: a restricted in-house frontmatter parser

No anchors or aliases (so no billion-laughs expansion) and a depth cap,
differentially fuzzed against npm `yaml` (QR-28h). A document whose
frontmatter uses anchors is refused — an accepted behaviour change.
Markdown uses markdown-rs.

| Alternative | Why rejected |
|---|---|
| `serde_yaml` | Archived |
| `serde_yml` | RUSTSEC-2025-0068, unsound |
| The libyaml-based forks | Carry `unsafe-libyaml`, which the `unsafe` ledger (decision 16) would have to absorb for a format whose frontmatter subset is small |

### Defaults adopted with this ADR

Taken from the tooling research and the architecture analysis, and recorded
here so a later change is a decision rather than a drift. A later ADR may
revise one without reopening decisions 1–25.

| Area | Default | Alternative rejected, and why |
|---|---|---|
| Schema dialect | JSON Schema 2020-12, restricted (Seams, 8) | Draft-07: 2020-12 is MCP's default dialect, Zod 4's and schemars 1.x's |
| Tool schemas | Published from the JSON files directly | From generated Zod: ADR-0031's byte scoreboard would then measure generator noise |
| Generator | A Rust `xtask` emitting Zod SOURCE and serde types; typify spiked for the Rust half, an own emitter if it fails | typify alone: `anyOf` flattens imprecisely, numeric bounds are not enforced, 2020-12 `prefixItems` + `$ref` is reported broken |
| Wasm boundary | JSON strings or bytes, validated by the generated Zod | serde-wasm-bindgen: measured ~30% slower than `JSON.parse` for many small objects; `tsify`: a second type source |
| Wasm toolchain | `wasm-bindgen-cli` pinned equal to the crate, then `wasm-opt` | wasm-pack: one maintainer since the rustwasm org was sunset |
| Artifacts | `render` (layout, SVG, codec, digest) and `full` (adds crdt, ops, search, reference-graph), each with a size ledger | One artifact: the viewer and the MCP Apps widget would carry the CRDT |
| Text measurement | Inside the core (Seams, 1) | A per-run host callback: the hottest boundary in the system |
| Logging | Own RFC 5424 facade (Seams, 3) | `tracing`: five levels, so notice, critical, alert and emergency are lost |
| Errors | Generated `RefusalCode` (Seams, 4) | Hand-written per language: the drift `v1-refusals-cover-errors` exists to catch |
| Async | `MaybeSend` ports (Seams, 7) | `async-trait` boxing everywhere, or `Send` everywhere, which wasm cannot satisfy |
| Daemon SQLite | rusqlite, bundled; migration log keys kept identical | libSQL client: only if a libSQL-specific feature is in use |
| Daemon shape | Plain binary under biome-style `optionalDependencies` plus GitHub release binaries; static musl on Linux (decision 19) | napi-rs addon (decision 1) |
| Workers MCP | `rmcp`-on-wasm spike before planning it | Assuming rmcp works without tokio |
| Scene across the boundary | Decided before the composer is ported (Seams, 8) | Deciding it during the port |
| Highlighting | A host seam during the transition (lowlight stays in TypeScript), then decided on measurements | A Rust highlighter now: none is a twin of highlight.js, so byte parity fails on the first fence |
| Browser storage | Stays TypeScript (IndexedDB/OPFS) behind coarse ports | Rust over IndexedDB bindings: no gain, and the ports are coarse enough that the boundary is cheap |
| Version skew | A protocol version in the daemon-to-web handshake, now | Compatibility shims: the project ships none pre-1.0 |

#### The generator spike (2026-11-07): typify fails, the own emitter it is

The Generator row's condition was measured rather than assumed. `cargo-typify`
0.10.0-alpha.3, the newest release, was run over the geometry contract
(`Point`, `Rect`, `Side`, `EdgeRoutingStyle`) and a probe of the restricted
dialect's other constructs:

| Construct | What typify emits | Verdict |
|---|---|---|
| A string enum | A Rust enum with serde renames | correct |
| `additionalProperties: false` / absent | `deny_unknown_fields` / none | correct for `refuse` and `strip` |
| `pattern` | A `regress` (ECMAScript regex) check | correct |
| `minimum` / `maximum` on a number or an integer | A bare `f64` / `i64` | **not enforced** |
| `maxLength` | A check on `chars().count()` | **the wrong unit**: code points, where Zod's `.max()` counts UTF-16 units |
| `x-wb-maxUtf16`, `x-wb-check`, `x-wb-unknownKeys` | Nothing | **ignored** |
| A `prefixItems` tuple of two `$ref`s | `[PairItem; 2]` over an empty `enum PairItem {}` | **broken**: an uninhabited type |
| Object fields | Alphabetical order | a note, not a blocker: the canonical JSON (RFC 8785) the byte comparison uses sorts keys |

Three of those are exactly the divergences this ADR exists to make
structural — a bound one side checks and the other does not, and a length in
two units — and the dialect's own keywords would need a second pass over
typify's output in any case. So the Rust half is the same `xtask` emitter as
the Zod half, generated from one walk of each schema, so each construct's two
meanings are written side by side, and the differential harness still checks
that they agree.

That emitter is `cargo xtask codegen` (`crates/xtask/src/codegen/`). Its
dialect is what its typed parse accepts — today closed objects of required
numbers with an inclusive `minimum` — so a construct it does not implement is
refused by name rather than dropped from one language's output, and the
dialect grows with the contract that needs a construct. `codegen --check`
fails on generated output that differs from its contract and on a file under
a `generated` directory that no contract produces.

#### The routing spike (2026-11-07): the port holds, a per-edge boundary does not

The first instrument the migration order names. `grid-route.ts` (the A*
search over the Hanan grid that the side-choice search falls back to) was
ported structure for structure to `whiteboard-edge-routing`
(`grid_route.rs`, `min_heap.rs`). Three places needed work to give the same
answer:
- `Math.min`/`Math.max` propagate NaN and order the zeros (`det::math::js_min`/`js_max`);
- a `Set<number>` dedups by `SameValueZero` in insertion order and stores `-0` as `+0`;
- the heap's tie order, which picks among equal-cost routes, is the TypeScript's own sift.

The port is exported to wasm as `edge_route_on_grid` over typed arrays.

Layer 1 of the harness ran on it. `canvas-render-rust` re-runs every
`layout/edges` suite with `./grid-route.js` aliased to the wasm-backed shim,
except `grid-route.cost.test.ts`, which counts the TypeScript search's own
obstacle reads. That includes the optimality property against its
independent Dijkstra, and the routing and grid-route scoreboards. Every pinned
number held with no expectation edited. A bend cost of 81 in the Rust port
fails the grid-route scoreboard, and a `<=` in its heap's sift fails the
routing scoreboard's clustered canvas.

Layer 2 found what layer 1 could not. `grid-route.rust.test.ts` holds the two
to the same path and spent budget on one draw, every coordinate by
`Object.is`, and its first run failed. The cause was the `-0` above: the port
kept `-0` as given, which no example of the TypeScript's draws.

Measured on one machine, interleaved:

| What ran | TypeScript | Rust through wasm |
|---|---|---|
| `routeOnGrid`, 200 clustered queries (both agree on all 200) | 16.4–17.9 Hz | 33.5–35.9 Hz |
| `assignEdgeAnchors`, 60 nodes / 200 edges, mean | 332–339 ms | 444–480 ms |
| `routeEdge` over 200 edges, straight, mean | 41–43 ms | 57–62 ms |

The layout rows were taken with the shim's ABI check made once rather than
per call, so they charge the routing export alone. The search itself is about
twice as fast. The layout is 30–45% slower, because
every grid call crosses the boundary and copies its obstacles into a typed
array, and most calls in a layout are small. That is QR-22b measured on this
code rather than argued: the port moves `layout/edges` as a whole, behind one
call per layout. The per-edge export is the spike's scaffold, not the shape of
the port.

The integrator adopted these from the gap research the same day; like the
rows above, a later ADR may revise one:

| Area | Default | Alternative rejected, and why |
|---|---|---|
| Boundary granularity | One boundary call per user operation, never per node; a boundary-cost bench per runtime, JSON against serde-wasm-bindgen (QR-22b) | Per-item calls: the cost that drove another project's Rust engine back out |
| State ownership | The `LoroDoc` ends inside the wasm; the web app leaves `loro-crdt` with the loro cohort, and two Loro copies exist only until then | The document in JavaScript beside a wasm core: every operation would cross the boundary with the whole document's state |
| Toolchain unit | Toolchain, `wasm-bindgen` and `-Ctarget-feature` baseline pinned as one unit; bumped every 1–2 releases in its own PR; no MSRV lane (QR-5a) | An MSRV lane: no crate is published, and the edition 2024 resolver is MSRV-aware |
| Unicode | Pinned explicit crates with a version-asserting test; the oracle uses the same segmenter or the fixtures record the version (QR-20b) | std's tables, which follow the toolchain |
| Parser limits | One shared TypeScript/Rust limit contract; `serde_json/unbounded_depth` banned; explicit regex `size_limit`; a deep-but-valid property inside wasm (QR-28b) | Per-site limits, which TypeScript and Rust would set differently |
| Windows | Named pipes with `first_pipe_instance(true)` and an owner-only DACL in one ledgered `unsafe` crate, with a Windows CI test (QR-28i) | Spreading the `unsafe` call into the daemon binding |
| Logging bridge | The RFC 5424 severity carried as a field through `tracing`; spans to the host's `@opentelemetry/api` from wasm, tracing-opentelemetry natively (QR-25b) | Mapping onto `tracing`'s five levels |
| Supply chain | `cargo auditable` for the daemon; cargo-deny sources limited to crates.io with a review for every new crate; zizmor over the workflows; cargo-vet only for network-facing dependencies (QR-27a) | Accepting git or alternative-registry sources |
| Notices | `cargo-about` notices in every platform package and the web bundle (QR-27d) | Hand-maintained notices |
| CI throughput | rust-cache saved from `main`; nextest archive and partition with no retries; doctests separately; native arm64 runners; cross-compilation only for musl and the glibc floor; build timings as an artifact; a compiler cache only if measured (QR-32b) | Emulated arm64, and caches nobody measured |
| Worktrees | A per-worktree `CARGO_TARGET_DIR` seeded from the main checkout; targets installed by the session hook; lanes pre-built (QR-32c) | A cold build per worktree |
| Wasm memory | Peak-memory reports on a real board, Workers startup measured, an explicit maximum memory, `opt-level` chosen per artifact (QR-22d) | One optimisation level for every artifact |
| Errors | `thiserror` in libraries; `anyhow` only in the daemon's `main`, banned from core and ops by the architecture map; a `kind()` tied to the generated codes (QR-26b) | Type-erased errors in libraries |
| Exit criteria | Structure-preserving or redesigned recorded per module; a TypeScript deletion deadline (by default the release after the switch first defaults to `rust`); rollback is flipping the switch (QR-33b) | Leaving the TypeScript in place indefinitely "just in case" |
| Crash reports | A local, redacted report written by the panic hook and attached by the user through the support bundle; no telemetry (QR-25c) | A hosted crash service |

Considered and not adopted: cargo-semver-checks (no crate is published; the
`.d.ts` and wasm export surface are diffed instead), denying `missing_docs`
(only `broken_intra_doc_links` is denied), a feature-powerset CI lane
(features are kept near zero), and per-crate CODEOWNERS.

## Target crate graph and layering

A crate's directory is its layer. Packages are still cut by runtime
requirement.

| Layer | Crates | Runtime rule |
|---|---|---|
| `crates/core/*` | `det`, `log`, `model`, `facet-engine`, `scene`, `codec`, `search`, `plugin-visual`, `edge-routing`, `canvas-render`, `crdt`, `workspace-index`, `history`, `reference-graph` | std, `#![forbid(unsafe_code)]`, no I/O; OS reach banned by lint and proven by the wasm import scan; synchronous — core never sees a `Future` |
| `crates/ports/ports` | async I/O traits: `DocumentStore`, `DocumentIndex`, `BlobStore`, `WorkspaceRecordStore` (coarse: load bytes, append update, compact), `Clock`, `IdMint`, `Scheduler`, `MeasureText` (host fallback), `FontSource`, `WorkspaceLock`; the error taxonomy | the only route to I/O |
| `crates/ops/*` | `ops` — every `/api/v1` operation and MCP tool as `execute(input) -> Result<Output, Refusal>` over ports, the tool table as data, `withWorkspaceWrite`, the refusal codes; `api-contracts` — generated `/api`, sync-frame, tool I/O and refusal types | transport-neutral |
| `crates/adapters/*` | `http` (axum, default features off, no tokio), `mcp` (a JSON-RPC dispatcher over the ops tool table) | translate only |
| `crates/mechanics/*` | `daemon-store` (SQLite record store, fs blobs, versions, migration runner, file GC, atomic write, data layout, security stores, export), `edge-store` (Durable Object, D1, R2) | store implementations |
| `crates/bindings/*` | `wasm` (wasm-bindgen cdylib, `render` and `full` features, `abi_version()`), `worker` (workers-rs: router, MCP over HTTP, edge-store, DO alarms), `daemon` (native binary: tokio, hyper on the owner-only socket of [ADR-0050](0050-local-daemon-trust.md), MCP stdio, the extension's native-messaging host, resvg PNG export, font install, the background-work registry) | composition roots; `unsafe` permitted only here |
| `crates/xtask` | codegen, architecture-map check, wasm import scan, size ledger | build tooling |

What each core crate absorbs:

| Crate | Absorbs |
|---|---|
| `det` | nothing — new: JS-compatible `toFixed`/`formatCoord`, det-math, UTF-16 helpers (`compareCodeUnit`, lengths, indices), seeded RNG, ordered collections |
| `log` | `server-core`'s log seam |
| `model` | `packages/model`, plus the invariants a schema cannot state (path and id grammar, `storedImageRefs`, facet key grammar) |
| `facet-engine` | the facet engine's data half, over the facet-schema dialect |
| `scene` | `packages/scene`; the contribution traits `RenderContribution`, `ShapeContribution`, `NodeDecoration`, `EdgeRouter` |
| `codec` | `packages/codec` (markdown-rs for mdast; a restricted in-house frontmatter parser, decision 25) |
| `search` | `packages/search` (unicode-segmentation) |
| `plugin-visual` | the bundled plugin's default entry, `/render`, `/emoji*`, `/icons/shortcode` |
| `edge-routing` | `canvas-render`'s edge layer: side choice, anchors, Hanan-grid A*, crossings, jumps, rounding, label anchor, budget, route cache |
| `canvas-render` | the rest of `canvas-render`: composer, typesetter, line break, truncation, theme, ink and glow, SVG backend, `sceneDigest`, references (ttf-parser, a UAX #14 crate, BudouX vendored) |
| `crdt` | `loro-adapter` (loro pinned `=`) |
| `workspace-index`, `history`, `reference-graph` | the TypeScript packages of the same names |

`edge-routing` is split from `canvas-render` because `layer-boundary.test.ts`
already shows the edge cluster has no production import from the node layer
or the composer: the split costs nothing now and a reshuffle later.

**Allowed directions** (a crate depends only on crates to its left):

- `det`, `log` < `model` < `facet-engine` < `scene` < {`codec`, `search`} <
  `plugin-visual` < `edge-routing` < `canvas-render`
- `model` < `crdt` < {`history`, `workspace-index`, `reference-graph`}
- `ports` sits beside `crdt`
- core + `ports` < `ops` < `adapters` < `bindings`; `mechanics` < `bindings`
  only

Adapters never depend on mechanics, so [ADR-0018](0018-operation-vs-mechanic.md)'s
one invariant holds by the dependency graph itself: no allowlist, no
ceiling.

**Stays TypeScript:** `apps/web`, `facet-ui`, `plugin-visual/ui`, the React
half of `canvas-viewer`, `apps/extension`; `daemon-client`'s transport half
(SSE hub, `api-client`) over generated Zod; browser storage as JavaScript
implementations of the ports; the Canvas-API measurement fallback for system
fonts; `packages/core-wasm` (`@kamiazya/whiteboard-core-wasm`: the artifacts,
a thin shim and init, no `node:*` — roots hand it bytes or a `Module`);
`tools/*`, with arch-lint reading the language-neutral map.

**One architecture map.** `crates/architecture-map.json` serves both languages: per
entry `lang`, `layer`, `targets`, `absorbs`/`absorbedBy`, `status`, and
`allowedThirdParty` with a reason each. The TypeScript scans read it; the
Rust check (`xtask arch-map`) reads `cargo metadata` against it (QR-10).

## Seams fixed now

Each of these is expensive to move once code depends on it, so it is fixed
before the first port.

1. **Text measurement is inside the core.** A `FontTableMeasurer` over
   ttf-parser reads hmtx advances (unkerned, unhinted), satisfies the existing
   `describeMeasureTextConformance`, and keeps the per-code-point estimator
   as the fallback, detected by glyph index. The browser layout worker
   already posts the theme's faces before measuring, so the bytes exist on
   every surface. The host callback remains a port for system fonts and
   tests only, in a fixed shape: fonts interned as `FontId`, the core
   memoising by `(FontId, size, text)`, and an optional `measure_batch` so a
   host answers once per paragraph. Browser and daemon then measure
   identically by construction.
2. **Plugins: traits that take data, and a closed set of contribution
   points.** The bundled plugin implements the traits; the declarative
   manifest (decision 12) is just another implementer. Facet schemas are
   authored in the neutral dialect, not Zod. Trait methods take data, never
   closures. The contribution points stay a closed, core-owned set.
3. **A logging facade of our own.** Eight RFC 5424 levels; a fields-first
   macro, so the pino dropped-argument class (`log.warning('msg', x)`)
   cannot be written; the daemon sink writes the JSON line pino writes today;
   redaction is one shared data list read by both pino and the Rust sink;
   third-party `tracing`/`log` output is bridged in bindings only;
   `println!`, `eprintln!` and `dbg!` are banned (QR-25).
4. **Errors are values with generated codes.** `thiserror` enums implement
   `Refusal { code, category, message, details }`. `RefusalCode` is
   generated from `contracts/refusals.json` (code, category, HTTP status, MCP
   mapping, description). Category-to-status and category-to-MCP-error are
   mapped in the adapters only. Across the wasm ABI an error is
   `{ok:false, refusal}`, and the shim rehydrates the TypeScript error
   classes during coexistence. An exhaustive `match` on `RefusalCode`
   replaces `v1-refusals-cover-errors`. Panics: decision 20, QR-26c and QR-28a.
5. **Determinism rules** (the divergences already found in the current code):
   - `toFixed` ties: JS picks the larger `n` on an exact tie, Rust rounds half
     to even (0.0625 → `"0.063"` in JS, `"0.062"` in Rust). `det::format_coord`
     implements the ECMAScript algorithm.
   - Transcendentals: at least 20 `Math.hypot` calls in shipped edge code
     (straight-detour cost, crossing sweep, jumps, label anchor), and
     `Math.cos`/`Math.sin` in jump arcs. Rust uses `libm`, never `f64::hypot`
     or std's float methods, which are documented as non-deterministic.
   - Iteration order: no `HashMap`/`HashSet` in core; `IndexMap`/`BTreeMap`.
     About 70 sort/Map/Set sites in the edge layer.
   - Sorting: no `sort_unstable`, no `partial_cmp().unwrap()`; comparators are
     total with the NaN policy written in `det`.
   - Strings: JavaScript counts UTF-16 code units — in comparison order, every
     `.length` limit, snippet offsets. Every offset or length in a contract
     declares its unit; `det` supplies the UTF-16 operations. Rust's `Ord for
     str` is UTF-8 byte order, which differs from UTF-16 code-unit order
     between U+E000–U+FFFF and the supplementary planes.
   - Unicode tables: `Intl.Segmenter` follows the host's ICU, Rust crates pin
     their own; the crates are pinned explicitly and their table version
     asserted by a test (QR-20b), and the one-time difference against the
     oracle is accepted and ledgered.
   - Floats: no relaxed-simd; a NaN is never hashed; canonical JSON is RFC
     8785; numbers are formatted by ryu-js, never serde's `1.0` for `1`.
6. **loro: one cohort, lock-step versions.** Pinned `=` with a cross-lockfile
   equality test; bidirectional fixtures (JavaScript export to Rust import,
   snapshot and updates, both ways); UI positions go through the `_utf16`
   APIs (spiked first); one `LoroDoc` is never split across two engines —
   only bytes cross; snapshot bytes are not canonical, so differentials
   compare deep values and frontiers. `loro-adapter`, `workspace-index`,
   `history` and `reference-graph` migrate as ONE cohort. End state: the UI
   holds no `LoroDoc`; operations run on a document inside the wasm, and
   `loro-crdt` leaves the browser bundle.
7. **Async ports with `MaybeSend`.** Core is synchronous. Ports and ops are
   async, returning `impl Future + MaybeSend` (RPITIT), where `MaybeSend` is
   `Send` natively and nothing on wasm32. `WorkspaceLock` is a port: an async
   mutex natively, the Durable Object itself on Workers. CPU-heavy calls
   never run on the reactor (`spawn_blocking` or a bounded pool). Background
   work keeps a typed registry, declared in `ops` and armed in the binding
   (tokio interval or DO alarm), carrying forward the daemon's
   background-work registry and its declared costs.
8. **The JSON boundary dialect.** Contracts live under
   `contracts/{geometry,model,api,mcp,facets}/` as JSON Schema 2020-12 in a
   restricted dialect:
   - no bare `maxLength` (it counts code points; Zod `.max()` counts UTF-16
     units); `x-wb-maxUtf16` instead;
   - `pattern` from a portable subset, compiled by both engines in CI;
   - every object declares `x-wb-unknownKeys: refuse | strip`; strict types
     are closed, flat objects (serde cannot combine `deny_unknown_fields`
     with `flatten`);
   - no implicit `null`; defaults generated into both sides;
   - integers bounded to ±2^53, no `u64` on the wire;
   - `description` mandatory on tool parameters, so every `.describe()`
     survives for ADR-0031's scoreboards;
   - refinements are named predicates (`x-wb-check`), implemented once per
     language and held equal by the differential harness; brands are
     `x-brand`; transforms are banned in contracts.

   Requests are strict and answers tolerant, as `api-contracts` are today.
   Drift is caught three ways (QR-6). The canvas-render rule that the scene is
   plain TypeScript ends once the UI reads a wasm-produced scene: either the
   scene becomes a generated contract, or hit-testing and overlays move into
   the core and only SVG and the digest cross. That choice is made BEFORE the
   composer is ported; the recommendation is the second where feasible.
9. **ABI and protocol versions.** The shim and the wasm come from one commit
   and one release (linked versions); `abi_version()`, a hash of the exported
   surface, is checked at init, and the shim records a source hash so a stale
   artifact fails loudly. The export surface is coarse, with a declared
   fast-path class that may use typed arrays (live-drag edge relayout). The
   skew that really matters is the user-installed daemon against the
   always-latest hosted web app over `/api` and sync frames: a protocol
   version enters the handshake NOW, answered by an update notice
   ([ADR-0048](0048-update-notice.md)) rather than a compatibility shim.

## Transition mechanics

**A per-function switch, set by the composition root.** A `CoreImpl`
registry keyed by function name holds `ts | differential | rust`. The
composition root sets it and passes it through options (for example
`SpatialLayoutOptions.core`); nothing reads it ambiently. `differential` runs
both, compares canonical output, reports a mismatch with a minimal repro, and
returns the TypeScript answer. Each function's lifecycle:

| Stage | Switch | What runs | Leaves when |
|---|---|---|---|
| 1 | `ts` | TypeScript only | the Rust port compiles and its native tests pass |
| 2 | `differential` | both, in CI and in dogfooding; TypeScript answers | the parity checklist (QR-33) is met |
| 3 | `rust` | Rust answers; TypeScript is still present, so rollback is flipping the switch back | one release with no mismatch reported; by default the TypeScript is deleted in the next release, later only with a recorded reason |
| 4 | — | TypeScript deleted; its tests kept and pointed at the shim | the whole package is absorbed |
| 5 | — | tests move to Rust (proptest) | — |

**The `PORTED_FUNCTIONS` ledger** is both-sided: every function in stage 2 or
later is listed; once its switch is `rust`, the TypeScript export must be a
re-export of the shim; a listed function that no longer exists fails.

**A three-layer differential harness** (QR-21):

1. **Existing suites against Rust.** A vitest project
   (`canvas-render-rust`) re-runs the `layout/edges` tests, scoreboards
   included, through the shim. The scoreboards pin IDENTICAL numbers with no
   expectation edited.
2. **Property differential.** fast-check canvases, TypeScript against wasm,
   exact equality on discrete outputs (cost tuples are already quantised by
   `COST_QUANTUM`). The harness is mutation-checked by planting a one-ulp
   change on the Rust side and watching it fail.
3. **Cross-target Rust.** The same fixtures natively and under
   `wasm-bindgen-test` on Node, byte-equal.

**The edge-routing contract** is a narrow wire —
`EdgeRoutingInput { nodes: [{id, rect, group…}], edges, styles, frozen sides,
budget }` and its output — onto which the shim projects `SpatialNode`s. It
is what lets `edge-routing` port before `model`.

**Build.** `cargo build -p whiteboard-wasm --target wasm32-unknown-unknown
--release` with `render` or `full`, then `wasm-bindgen --target web` (CLI
pinned equal to the crate, checked in CI), then `wasm-opt`. Init takes bytes
or a `Module` from the root: a Vite `?url` import, `fs` in `mcp-server`, a
module import on Workers. tsdown `noExternal` copies the wasm as an asset.
Generated code is checked in: `crates/*/src/generated/*.rs` and
`packages/*/src/generated/*.zod.ts`.

**Per-module exit criteria** (QR-33b), recorded in the PR that moves a
module's first switch to `rust`: whether the port is structure-preserving or
redesigned, and why; the release by which its TypeScript is deleted — by
default the release AFTER the one in which the module's switch first defaults
to `rust`, so one release of differential data, and later only with a
recorded reason; and that rollback is
flipping the switch in the composition root, nothing more. A
structure-preserving port is the default: reading the two side by side is
what lets layer 1 of the harness carry most of the proof. Another TypeScript
compiler port chose Go over Rust precisely because a structure-preserving
port was intractable in Rust; this migration keeps the core synchronous and
data-oriented so that it is not, and records each module that had to be
redesigned instead.

## Freeze policy for `packages/*` during the migration

| Change | Allowed? | Condition |
|---|---|---|
| Bug fix in a module at stage 1 | Yes | TypeScript only; the oracle carries it into the port |
| Bug fix in a module at stage 2 or 3 | Yes | The SAME PR fixes both sides and adds the regression test to the shared suite or fixture corpus, so the differential pins it |
| Bug fix in a module at stage 4 | Yes | Rust only |
| New feature, new field, changed contract or specification | No, until the module's freeze lifts | Lifts PER MODULE once its switch is `rust` and its TypeScript is deleted; from then on its new features go to Rust (decision 23) |
| Refactor of TypeScript that is being ported | No | It moves the oracle without moving behaviour; precursor changes (decision 11) are the exception |
| UI work in `apps/web` | Only bug fixes | The UI/UX loop is stopped (decision 9) |
| Tooling, CI, arch-lint, docs | Yes | — |

A golden or scoreboard number moves only at the precursor (decision 11) or
through a ledgered exception.

## Migration order

| # | Step | Gate to the next step |
|---|---|---|
| 0 | Wave 11 merges; the UI/UX loop stops; the freeze begins | — |
| 1 | Scope-aware CI (decision 10) | `ci-gate` honours scope; full run on `main` |
| 2 | `loro-crdt` 1.13.6 → 1.17.x in TypeScript (decision 13) | current suites green |
| 3 | This step (decision 8): skeleton, gates, schema pipeline on the geometry contract, harness | each gate in QR-1…QR-32 has a running job, mutation-checked |
| 4 | det precursor in TypeScript (decision 11) | goldens and scoreboards moved once, with reasons |
| 5 | Geometry contract and `edge-routing` — the routing spike, then the port | parity checklist; routing scoreboards identical |
| 6 | `model`, `facet-engine`, `scene`, `codec`, `plugin-visual` data half | codec round-trips byte-identical; markdown-rs stringify spiked first; the restricted frontmatter parser differentially fuzzed against npm `yaml` |
| 7 | `canvas-render` (scene-across-boundary decided first) | SVG golden byte-identical on TypeScript, native and wasm |
| 8 | `search` | search-quality scoreboard identical; Unicode-table diff ledgered |
| 9 | The loro cohort: `crdt`, `workspace-index`, `history`, `reference-graph` | bidirectional fixtures; deep-value differential |
| 10 | `ops`, `http`, `mcp` | `pnpm smoke:e2e` and ADR-0031's scoreboards against both servers |
| 11 | Bindings: `worker`, then `daemon` | port conformance suites; native-host smoke on Windows |
| 12 | Distribution (decision 5), with provenance, checksums, the hardening and reproducibility gates (decisions 16, 17), and signing scaffolded | packaged smoke per OS with `--ignore-scripts`; release binaries pass QR-27b, QR-28d and QR-28e |

## Risks

| # | Risk | Mitigation |
|---|---|---|
| 1 | Byte-identical SVG against the oracle fails on `toFixed` ties, transcendentals or map order | The det precursor (decision 11), before any port |
| 2 | UTF-16 semantics — comparison, lengths, loro indices, `maxLength` | `det`'s UTF-16 operations; every contract offset declares its unit |
| 3 | Markdown/YAML parity: markdown-rs parses, but there is no remark-stringify twin; the YAML crates are archived or unsound | The restricted frontmatter parser, differentially fuzzed against npm `yaml` (decision 25); stringify spiked before step 6 |
| 4 | Line breaking: `css-line-break` strict (CSS kinsoku) against a UAX #14 crate with no strictness levels | Spike before step 7 |
| 5 | Highlighting has no Rust twin of highlight.js | Host seam through the transition |
| 6 | Two loro engines: size, version pin, `_utf16` APIs | One-cohort migration; lock-step guard |
| 7 | Workers: script size; CPU time for large layouts | Size ledgers per artifact; measured CPU per layout size |
| 8 | Live-drag boundary cost | Measure first; typed-array fast path kept available |
| 9 | A wasm panic poisons the instance, and state held inside it (a `LoroDoc`) goes with it | Recreate and rehydrate from persisted state, tested by a CI poison-and-recover scenario (decision 20, QR-26c) |
| 10 | Dialect gaps between JSON Schema, Zod and serde | The round-trip property and ADR-0031's scoreboards |
| 11 | CI and agent cost: coexistence doubles lanes; agents need cargo and the wasm target; worktrees need a warm `CARGO_TARGET_DIR` | Scope-aware CI first (decision 10) |
| 12 | Daemon store: kysely migrations re-expressed with identical log keys | Migration log keys are data in the database; a fixture of every shipped schema |
| 13 | Pre-1.0 tooling: workers-rs, typify and wasm-bindgen's new organisation | Spikes before commitment; the own emitter as typify's fallback |
| 14 | OS code-signing certificates are not yet available, so early binaries ship unsigned and macOS Gatekeeper and Windows SmartScreen warn | Provenance and checksums from the first release; signing scaffolded and enabled when the owner provides certificates (decision 17) |
| 15 | Nightly-only tooling (sanitizers, branch coverage) drifts | A pinned nightly beside `rust-toolchain.toml`; both are report or scheduled lanes, never the only gate |

## Consequences

- **Easier:** one implementation of every rule that matters, compiled once
  for every runtime; determinism by construction instead of by coincidence;
  ADR-0018's invariant enforced by the crate graph instead of a ledger; a
  daemon that needs no Node; the CRDT driven in its own language; a stricter
  mutation and coverage bar on the code that remains; fuzzing, hardening,
  reproducible builds and provenance as gates the TypeScript daemon never had.
- **Harder:** two toolchains during coexistence — every agent and CI runner
  needs cargo, the wasm target and a pinned `wasm-bindgen-cli`; every ported
  function costs a differential until its TypeScript is deleted; the
  freeze stops product work in `packages/*` for the duration.
- **Every untrusted-input entry is a registered thing**, with declared caps
  and a fuzz target; adding an entry without them fails a guard.
- **Releases get slower and stricter:** two builds per artifact for the
  reproducibility check, a hardening check, provenance and checksums.
- **Panics have a recovery path that is tested**, and state held inside a
  wasm instance must be rehydratable from what the keeper persisted.
- **The freeze is per module** (decision 23): product work resumes module by
  module, in Rust, as each TypeScript implementation is deleted.
- **Support promises are written down** — an engine-support matrix and a
  browser policy that freezes at GA — and the wasm baseline follows them.
- **Frontmatter with YAML anchors or aliases is refused** (decision 25).
- **The security bar is external:** the OpenSSF and the other standards of
  decision 18, mapped in `docs/contributing/security-baseline.md`.
- **Contributors** must read Rust to change the core; the UI stays React.
- **The Zod discipline** keeps its reader-facing form (`z.infer`, never a
  parallel interface) but its schema is written in `contracts/`, and a
  hand-edited generated file fails CI.
- **Goldens and scoreboards move once,** at the precursor, and never again
  without a ledger entry.
- **canvas-render's "the scene is plain TypeScript" rule ends** when the UI
  reads a wasm-produced scene; its replacement is decided before step 7.
- **ADR-0052 is amended** (decision 6); its edge keeper becomes a Rust
  binding.
- **The quality bar is written once, language-neutrally,** in
  [Development quality requirements](../quality-requirements.md); a Rust
  module is not switched to `rust` until it meets that document's parity
  checklist.

## Alternatives considered

Each decision above lists the alternatives it rejected. At the level of the
whole initiative:

| Alternative | Why rejected |
|---|---|
| Stay in TypeScript | Keeps determinism observed rather than structural, the daemon's Node requirement, and a TypeScript driver for a Rust CRDT across a wasm boundary |
| Port only measured hot spots, later | Each port would then need its own boundary and its own contract; the neutral schema and the crate graph are cheaper to fix once, before code depends on them |
| A rewrite without an oracle | Loses the existing suites and scoreboards as the specification, which is what makes the port verifiable at all |

Deliberately not done: a `no_std` core, wasm threads or SIMD, wasm-component
plugins, porting tests before a package is fully absorbed, a Rust
module-cycle checker, and compatibility shims.
