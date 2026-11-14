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
and the web editor under development and in CI, and `ts` in a release. Every
released build now CARRIES the artifact while the default stays `ts`: the
`@kamiazya/whiteboard-mcp` tarball (`dist/assets/core-wasm`, with its
THIRD-PARTY-NOTICES), the Docker image and the Cloudflare Pages site, each
built from cold in the release workflow (`.github/actions/core-wasm` with
`use-cache: 'false'`). A release build that lacks it fails: `prepack` refuses
the tarball, and `WHITEBOARD_SHIP_CORE_WASM=1` fails the web build and the
image. The tarball smoke installs the package and runs in `differential` with
mismatches throwing, so an install whose artifact does not load fails there.
Moving the default is a setting change, not a packaging one. The wasm's Rust
crates are not components of the SBOM (`generate-npm-sbom.mjs` lists npm
packages only); the licence text is in the shipped THIRD-PARTY-NOTICES. It is
listed in the `PORTED_FUNCTIONS` ledger (`tools/arch-lint/src/ported-functions.ts`).
The switch may not move to `rust` until every row of its parity checklist,
[parity/edge-routing.md](../parity/edge-routing.md), is met or not applicable.
The decisions below are unchanged.

**Status note (2026-11-09, the first switch moves).** Edge routing now
defaults to `rust` in the daemon (`WHITEBOARD_CORE`) and in a production web
build (`VITE_WHITEBOARD_CORE`); `differential` stays the default of the dev
server and of CI's test jobs, and a plain test run stays on `ts` because a
jsdom page cannot fetch the artifact. Rollback is `WHITEBOARD_CORE=ts` for the
daemon and a web build with `VITE_WHITEBOARD_CORE=ts` (a build needs the
staged wasm otherwise, and fails without it rather than shipping a stub). A
daemon whose artifact cannot load still answers in TypeScript and logs a
warning carrying `event: 'core-load-failed'`. The parity checklist's rows are
met; row 1 (the flat `Float64Array` wire, decision 9) is accepted as the
declared deviation and row 10 rests on CI's differential runs (owner decision
q18). The `PORTED_FUNCTIONS` entry stays at stage 2: the ledger's stage 3 makes
the TypeScript export a re-export of the shim, which is the TypeScript's
deletion and would remove the rollback, so the entry moves when the TypeScript
is deleted, the release after the first one that defaults to `rust`.

**Status note (2026-11-09, the second module reaches `differential`).** The
OKF envelope (`parseOkf`, `serializeOkf`) is ported to `whiteboard-codec`,
reached through two wasm exports, `okf_parse` and `okf_serialize` (ABI 15),
and switched by `okfCodec` in `packages/codec`. `WHITEBOARD_CORE_OKF` and
`VITE_WHITEBOARD_CORE_OKF` run it `differential` in development and CI; one
wasm instance serves both modules in each realm. Its checklist is
[parity/okf-codec.md](../parity/okf-codec.md); every row is met or not
applicable, and the switch has since moved: both settings default to `rust`
(a test run of the web app stays `ts`), with `=ts` as the rollback. The one
difference tolerated is a `yaml`-stage refusal's wording (owner decision q25).
The TypeScript is deleted on the default schedule, the release after the
first one that defaults to `rust` (owner decision q26), which first needs the
wasm initialised synchronously wherever the synchronous `parseOkf` and
`serializeOkf` run. The decisions below are unchanged.

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
`contracts/plugin/plugin-manifest.schema.json`, emitted as Zod and Rust types
like every other contract. As built, the manifest holds a plugin's id, its
facets (targets, version, asset refs, editor declarations, compat entries) and
the NAMES of what only code can be: a payload schema, a catalog loader, an
asset table, a migration. The host supplies those by name, and
`pluginFromManifest` runs the same definition-time checks a hand-written plugin
meets. Declarative decorations are deferred (the emoji catalog and the
asset tables stay TypeScript behind named references), and an interpreter that
runs a manifest in the Rust core is a later step.

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
dialect is what its typed parse accepts, so a construct it does not implement
is refused by name rather than dropped from one language's output, and the
dialect grows with the contract that needs a construct. Today that is numbers
with an inclusive `minimum`; strings with `x-wb-minUtf16`, an anchored
`pattern` (with `x-wb-matcher` and `x-wb-message`) and a named `x-wb-check`;
arrays; `$ref`s to a definition, emitted in dependency order; `x-wb-any`
values and records of them; and objects with optional fields in `x-wb-order`
and `x-wb-unknownKeys: refuse | strip | keep`. A named check or matcher is a
hand-written predicate in both languages (`x-wb-checks` names the two
modules), and `codegen --check` fails when either is missing. Three contract
switches choose the emission: `x-wb-describe` (`.describe()` in Zod),
`x-wb-rustSerde` (serde in Rust; a crate that may take no dependency emits
plain data types) and `x-wb-readonlyTypes`. `codegen --check`
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

#### The markdown stringify spike (2026-11-09): no twin, and no caller yet

Step 6 names this spike first. Can a Rust stack write an OKF body byte for
byte as `stringifyMarkdownBody` (remark-stringify with the codec's GFM, math
and `referenceLiteral` extensions) writes it? The corpus was harvested at run
time from the codec's own 47 test files: 595 distinct mdast roots and 605
distinct markdown strings, fast-check cases included.

| Pipeline | Byte-identical |
|---|---|
| the codec's own tree into `mdast_util_to_markdown` 0.0.2 | 355 / 595: 320 / 357 trees with no reference, 35 / 238 with one |
| `markdown` 1.0.0 (markdown-rs) parse, then the same stringifier | 288 / 605 |
| `comrak` 0.59.0 parse and `format_commonmark` | 141 / 605 |

`mdast_util_to_markdown`, the Rust port shipped beside markdown-rs, is the
closest twin. Its options already equal remark-stringify's defaults, so
configuration is no lever. It has:
- no handler or `unsafe` hook, so it cannot be taught `referenceLiteral`;
- no GFM output (a table errors, a task-list checkbox is dropped, GFM's
  unsafe patterns are missing);
- one port bug that puts a space before inline `html`, which alone accounts
  for 142 of the differences;
- a lag behind mdast-util-to-markdown 2.1.x in character-reference encoding
  and in `safe()`.

Byte identity therefore means forking it into `crates/` and porting the
to-markdown halves of gfm-table, strikethrough, task-list and
autolink-literal. That is estimated at one to two weeks, plus the
differential lane this spike built.

The writer has no production caller. `serializeOkf` writes `doc.body` verbatim, and
`stringifyMarkdownBody` is held ready for a bundle export that does not exist
yet (`test-only-exports.test.ts`). So step 6's codec round-trip is the OKF
string round-trip: frontmatter plus a verbatim body, with no markdown writer
on the Rust path. Owner question q20 puts this to the owner; the provisional
answer is to keep stringify in TypeScript until the bundle export gives it a
caller, and to port it then with this spike's harness as its gate.

#### The frontmatter spike (2026-11-09): a restricted reader and a ported writer hold

The other half of step 6's gate is the restricted frontmatter parser,
differentially fuzzed against npm `yaml` (decision 25).

What is used was surveyed over 227 frontmatters, the repo's markdown and the
codec's OKF fixtures:
- block and flow maps and sequences, plain or quoted keys, plain, double- and
  single-quoted scalars;
- no tags, anchors, block scalars, tabs or CR.

What `yaml.stringify` writes adds more, and a reader must accept it all:
- `|` and `>` block scalars;
- scalars folded at 80 columns;
- the explicit `? key` form, which it uses for any key longer than 1024
  UTF-16 units.

The subset is that union. Tags, directives, document markers, collection
keys, tab indentation and an implicit empty key are refused. Values resolve
by npm's own core-schema rules: the written-integer rule, duplicate keys
compared by resolved value, and JavaScript's own-key order.

**Reader.** A hand-written Rust reader for the subset was checked, on a
holdout of 30,000 seeded cases never used for tuning, against the codec's
real `parseYamlKeepingWrittenIntegers`:
- it never accepted an input the TypeScript refuses, and never answered a
  different value;
- it refused 688 inputs the TypeScript accepts, all outside the subset;
- it disagreed on 7 mutated inputs about the refusal class.

`saphyr-parser` 0.3.3's events under the same resolver disagreed on 2.4%,
66 of them by accepting what the TypeScript refuses. `serde_yml` and its
`libyml` carry RUSTSEC-2025-0068 and RUSTSEC-2025-0067; `serde_yaml` and
`yaml-rust` are unmaintained.

**Writer.** A port of `stringify` that measures in UTF-16 code units was
byte-identical on 24,000 of 24,000 generated frontmatters, which included
3,569 block scalars and 1,737 explicit keys. The instrument was
mutation-checked: a line width of 79 makes 87 of 4,000 outputs differ.

Three findings shape the port:
- **The TypeScript reader is not restricted.** `frontmatter-yaml.ts` refuses
  only anchors, aliases and depth past 32, and passes the rest of YAML 1.2.
  Zero disagreement in both directions needs the TypeScript to refuse the
  same subset first. That is owner question q21; the provisional answer is
  yes.
- **Lone surrogates.** The TypeScript stores and writes lone UTF-16
  surrogates, which a Rust `String` cannot hold. They caused 420 of the
  8,000 writer round-trips to differ. Refusing them at write is not enough:
  a quoted scalar such as `x: "\uD800"` is inside the subset and the
  TypeScript reads it today. So owner question q22's provisional answer is
  to refuse a lone surrogate on BOTH sides, at write and at read, in the
  TypeScript and the Rust alike, so that zero disagreement holds on a
  frontmatter that carries one.
- **npm `yaml` 2.9.0's quote bug.** It finds a closing quote with
  `indexOf`, so whether a malformed quoted scalar parses depends on a quote
  further down the document. The spike ledgered it rather than copying it; the
  port copies it, because the recorded oracle showed the TypeScript accepting
  such scalars and zero disagreement was the gate: a quoted scalar left open
  (by the end of the text, or by a continuation line indented too little when
  a closing quote exists further on) is read as closed by its last character
  when that character is the quote, and refused otherwise.
- **The oracle is pinned.** The catalog asked for `yaml` `^2.8.4` and only the
  lockfile resolved 2.9.0, while the published `@kamiazya/whiteboard-mcp`
  keeps `yaml` external, so an install could resolve another 2.x. The catalog
  now names 2.9.0 exactly, so the differential measures the reader that
  ships from the next release on. Release 0.0.20 still declares `^2.8.4`;
  until a release carries the pin, an install of it can resolve another 2.x.

**Shipped (step 6, first increment).** `crates/core/codec` (`whiteboard-codec`,
module `frontmatter`) holds the reader (`parse`, for
`parseYamlKeepingWrittenIntegers`) and the writer (`stringify`, for the YAML
`serializeOkf` puts between its fences), on `whiteboard-det` alone with its own
ordered value type until `whiteboard-model` is ported. The gate is a recorded
oracle, the mechanism routing uses: `packages/codec/src/okf/oracle/frontmatter.jsonl`
holds the inputs and the TypeScript's answers (2,600 reader texts, accepted and
refused by class, and 1,053 writer values, bytes or refusal), a codec test fails
when the TypeScript stops answering as recorded, and
`crates/core/codec/tests/recorded_oracle.rs` replays it natively: every value,
refusal class and byte agrees. Nothing in TypeScript calls the Rust yet: there
is no wasm export and no switch, so the `PORTED_FUNCTIONS` entries, which start
at stage 2, come with the export. Three findings: `serializeOkf` loses a newline
from a last value that ends in two (`yaml` keeps a `|+` scalar's blank lines
and `serializeOkf` then strips one newline as content), which the Rust writer
reproduces and a test pins; `yaml` 2.9 folds a long string's more-indented line (one starting with a space) at a space, which a reader keeps as a line break, so that space comes back as a newline, again reproduced and pinned; and the Rust writer refuses collections nested past
64 levels, which the TypeScript writes.

**Shipped (step 6, second increment).** `whiteboard_codec::okf` holds `parse`
(`parseOkf`), `serialize` (`serializeOkf`) and `has_frontmatter`
(`hasOkfFrontmatter`) over crate-local document types, held by a second recorded
oracle, `packages/codec/src/okf/oracle/okf.jsonl` (1,200 documents and 500 writer
inputs; replayed by `crates/core/codec/tests/okf_oracle.rs`), where every
document, YAML refusal class, schema issue path and code, and written byte agrees,
with these declared deviations: refusal message text is not compared, a lone
UTF-16 surrogate cannot reach a Rust `&str` (the oracle counts those cases and the
future wasm boundary must refuse them as the TypeScript does), and the Rust types
write the modelled keys and a trust event's `by` and `at` in the schema's order
rather than the caller's. Still no wasm export or switch.

**Shipped (step 6, third increment).** The OKF envelope crosses the wasm
boundary: `okf_parse` and `okf_serialize` in `crates/bindings/wasm` (ABI 15),
`Core.parseOkf` and `Core.serializeOkf` in `packages/core-wasm`. The wire is
JSON, because a frontmatter value is arbitrary nested data; a double travels as
the hex of its 64 bits and a collection as one array, so a value nested to the
writer's cap stays inside `serde_json`'s recursion limit. The body never
crosses on the way out: a read answers the UTF-16 offset the body starts at and
the shim slices its own string, a write answers everything before the body and
the shim appends it, so the body is verbatim by construction. A read is sent
the head alone (the fences and the frontmatter), so a body of any size, or
holding a lone surrogate, never crosses; a lone surrogate in the head crosses as
a mark the artifact looks for among the strings and keys it read, which is the
TypeScript's refusal of one. The shim refuses a head past the cap and a
document the wire does not carry (a key the schema does not name, a value of
another kind) as `CoreInputRefused`, which a root answers from the TypeScript,
and a value with no YAML spelling as `CoreOkfUnwritable`, which carries each
place with its path and the TypeScript's words and which the root throws as
`OkfNotYamlSafeError`. Declared deviations: a YAML refusal's
message names its class, not the `yaml` package's text, and a schema issue
carries its path, code and a message naming the code, not Zod's extra fields.
The three other refusal messages are the TypeScript's own words.

The step-6 gate is met at the boundary. `codec-rust` (`packages/codec/src/okf/wasm.rust.test.ts`,
in CI's `rust` job after the wasm build) holds the artifact to `parseOkf` and
`serializeOkf` exactly: the 1,700 recorded cases, then 1,500 generated texts, 1,500
generated documents and 600 documents in shuffled key order per run, every value
compared by its bits, every mapping in enumeration order, the body verbatim, a
refusal by stage, schema issue path and code, with reach floors on every
outcome. Four one-character changes planted on the Rust side (an issue code, the
key comparison, the trust event key check, the body offset) each turned the
project red and were restored. `okf_wasm_parse` and `okf_wasm_serialize` fuzz the
two exports through the decode a host reaches (about 8M and 10M executions
locally, no finding), but libFuzzer cannot call npm `yaml`, so the
differential against the reader that ships is the generated one above, not a
coverage-guided one. The `PORTED_FUNCTIONS` entries wait for the switch, which
is the next increment: an entry needs a `CoreImpl` key to point at.

**Shipped (step 6, the JSON Canvas codec).** `whiteboard_codec::json_canvas`
holds `parse` (`parseSpatial`) and `serialize` (`serializeSpatial`, strict and
extended) over `whiteboard-model`'s generated spatial types, held to a third
recorded oracle, `packages/codec/src/spatial/oracle/json-canvas.jsonl` (1,400
texts and 600 canvases, replayed by
`crates/core/codec/tests/json_canvas_oracle.rs`). Every text reads, every
refusal's stage and each Zod issue's path and code, and every written byte
agree. The wire schema is read as Zod 4 reads it, so the port carries the
behaviours the TypeScript leans on: an issue that continues or aborts, a union
that reports the arm that only failed its pattern, a record that skips a
`__proto__` key, a bucket that `.catch(undefined)` costs, and `z.url()`
returning the trimmed text. Declared deviations: a refusal's message is not
reproduced, and the core declines (so the caller asks the TypeScript) a lone
UTF-16 surrogate written as an escape, nesting past 64 levels, a text over
4 MiB, and a link whose validity needs the host's URL tables (a non-ASCII or
`xn--` host, a percent-encoded host, an IPv6 literal, a `file` URL). The port
also found five places where the TypeScript and the contract disagree, none
changed here (the first is that `parseSpatial` never runs the model's own
checks): they are in [parity/json-canvas-codec.md](../parity/json-canvas-codec.md),
which is the checklist. The exports followed (the note below); there is still
no switch, and the `PORTED_FUNCTIONS` entries wait for it.

**Status note (2026-11-10, the JSON Canvas exports).** The codec is reached
through two wasm exports, `json_canvas_parse` and `json_canvas_serialize` (ABI
17), and `@kamiazya/whiteboard-core-wasm`'s `parseSpatial` and
`serializeSpatial`, which answer the TypeScript's own stages, issue identities
and error classes and decline (a typed refusal the caller's TypeScript answers)
what the core does not read. Codec's own spatial suites run against it with no
decline in any, and a live differential over the recorded corpus and generated
canvases and texts found four defects the recording could not (a number printed
halfway between two spellings, a length check on a value that is not a string,
a refinement's missing message, an edge's key order), each fixed, and one
quirk of the TypeScript's own lift, also fixed. **Measured on Node and
Chromium, the Rust path is slower than the TypeScript at every size: reads by
5x to 8x and writes by 15x to 25x**, because `JSON.parse` and `JSON.stringify`
are native in the host and the result crosses back as text; the checklist's
boundary section has the numbers. That is what the switch's default is decided
on, and it is not decided here: there is no switch. See
[parity/json-canvas-codec.md](../parity/json-canvas-codec.md).

**Status note (2026-11-10, the third module defaults to `rust`).** The JSON
Canvas codec is switched by `spatialCodec` in `packages/codec`, set by
`WHITEBOARD_CORE_SPATIAL` in the daemon and `VITE_WHITEBOARD_CORE_SPATIAL` in
the web app, which ran it `differential` in CI's daemon, browser and packaged
jobs with no difference or decline. Every row of its checklist is met or not
applicable, and both settings now default to `rust` (a test run of the web app
stays `ts`), with `=ts` as the rollback. The boundary cost above was the open
question, and the owner took the core despite it (decision q39): the TypeScript
is deleted on the default schedule, the release after the first that defaults
to `rust`.

**Status note (2026-11-10, the OKF TypeScript is deleted; q40 supersedes q26).**
The owner decided (q40) that the TypeScript of a ported module is deleted as
soon as its migration is complete, not in the release after the first that
defaults to `rust`. That replaces the schedule q26 kept for the OKF envelope and
the default in the transition table's stage 3 row, for every module: stage 4
follows a met checklist, not a release. The OKF envelope is the first to take it.
`parseOkf` and `serializeOkf` in `packages/codec` answer only through the core
each realm installs (`installOkfCore`), and throw `OkfCoreNotInstalled` where none
is; the `ts` and `differential` settings, `okfCodec`, `WHITEBOARD_CORE_OKF` and
`VITE_WHITEBOARD_CORE_OKF` are gone, the daemon installs the core at boot and
refuses to start without it, and every build of the web app carries the wasm.
The two ledger entries are stage 4 in a second shape: codec is a shared package
that must not import the shim, whose initialisation is asynchronous while these
exports are synchronous, so the export is a dispatcher over the realm's installed
instance and the ledger holds the deleted files gone, in place of a re-export
(`tools/arch-lint/src/ported-functions.ts`). What the core still declines is
refused with its reason where the TypeScript wrote (a read fails at the schema
stage, a write throws `OkfNotYamlSafeError`); the decisions are in
[the parity checklist](../parity/okf-codec.md). The checklist's rollback row is
now none.

**Status note (2026-11-10, the JSON Canvas TypeScript is deleted; q40, with q49
provisional).** The third module takes stage 4 the same way. `parseSpatial` and
`serializeSpatial` in `packages/codec` answer only through the core each realm
installs (`installSpatialCore`) and throw `SpatialCoreNotInstalled` where none is;
the `ts` and `differential` settings, `spatialCodec`, `SpatialMismatch`,
`WHITEBOARD_CORE_SPATIAL`, `VITE_WHITEBOARD_CORE_SPATIAL` and `ServerDeps.spatialCore`
are gone, and the daemon installs the core with OKF's at boot. What stays in
TypeScript is not a second implementation of the daemon's or the web app's answer:
the widget iframe has no core, so `canvas-viewer` keeps a TypeScript READER
(`readJsonCanvasText`, the wire schema and the projection) that no daemon, server-core
or web source may import (`spatial-reader-isolation.test.ts`). That is the
recommended option of open owner question q49 (`widget-ts-reader`), taken
provisionally until the owner answers; the alternative is a core in the widget. The
TypeScript writer is deleted outright. Declines are refusals where the TypeScript
answered ([the parity checklist](../parity/json-canvas-codec.md)).

**Shipped (step 6, S6).** `whiteboard_facet_engine::schema` interprets the
contract dialect at run time (owner decision q41): a contract file's `$defs`
compile into nodes and `Contracts::validate` judges a payload as the generated
Zod does, issue for issue in path and code and in order (the message may differ,
q43), so a plugin's payload schemas are data and a plugin not built into the
binary is judged by the same walk. The host supplies a contract's matchers,
named checks and `x-wb-external` definitions by name, and the model-only
constructs are refused at load by name. `whiteboard_facet_engine::registry`
builds over plugin manifests and answers `targets_of`, `asset_refs_of` and
`validate_facet_write` in the TypeScript registry's stage order. Both are held
to two recorded oracles (819 cases of the engine contract's asset schemas and
the plugin manifest; 2,768 lines of the bundled registry's declarations and
writes), replayed natively and on wasm32. The oracle found six behaviours of
Zod 4.6.7 the plan did not name (a list past its bound is refused alone, the
length checks run on any value with a `length`, among them); they are in
[the parity checklist](../parity/facet-engine.md). There is no wasm export and
no switch yet: the export, the shim and the `PORTED_FUNCTIONS` entries are S8.

**Shipped (step 6, S7).** The visual plugin's data half is Rust: the bundled
asset tables (themes, stencils, the lucide icons, the edge and category glyphs
and the signature) are JSON files in `packages/plugin-visual/src/assets/`, the
single source the TypeScript imports and the Rust core embeds (owner decision
q45; the emoji and shortcode tables stay for steps 7 and 8). `whiteboard_model::json`
is the JSON reader, moved from the codec because the facet engine reads its
contracts with it and `serde_json` sorts keys. `whiteboard_facet_engine::plugin::build`
loads a plugin from its manifest, contracts and tables, and
`whiteboard_plugin_visual::host::visual_registry()` is the bundled one; the
recorded write oracle now replays against it and asserts its registered ids.
Compat, the derived form, several plugins and a workspace stencil library, and
the wasm export and switch, are S8 ([the parity checklist](../parity/facet-engine.md)).

**Shipped (step 6, S8, the export).** The facet write crosses the wasm boundary as
one call: `facet_bucket_check` is `partitionFacetWrites` and the stencil
library's refusal over the bundled plugin's registry, which the artifact builds
once. `whiteboard_facet_engine::partition` walks a bucket in its order (the
facet's targets, the registry's write check, the key the schema strips, with the
TypeScript's reading of `key in parsed`) and composes a workspace's stored
stencil library beside the registry, a stencil at a time; the export answers the
sets, bit for bit, or the first key refused with its stage and the path and code
of each issue, and declines past its caps. `@kamiazya/whiteboard-core-wasm`'s
`facetBucketCheck` shims it (ABI 19), and server-core's `facet-write.core.test.ts`
holds it to `partitionFacetWrites` over generated buckets and a payload per
registered facet. The artifact's size is the cost of carrying the interpreter
and the plugin's files: 835,344 bytes shipped, 202,741 more, which is the price
of the daemon's only write validator being data-driven (owner decision q41). The
switch a root dispatches through, and the `PORTED_FUNCTIONS` entry, are the next
increments ([the parity checklist](../parity/facet-engine.md)).

**Shipped (step 6, S8, the switch).** The daemon's facet write is a per-function
switch, `WHITEBOARD_CORE_FACETS` (`rust` by default, with `ts` the rollback; `differential` in the dev
scripts and CI with mismatches throwing). server-core's `facetWriterFor` is the
dispatcher over `ServerDeps.facetWriteCore`: `rust` answers with the core and
throws the classes the TypeScript throws, and `differential` compares stage,
key, every issue's path and code in order and the stored sets bit for bit with
their key order, leaving the words out (q43). A call the core declines is
answered by the TypeScript. The daemon refuses to boot under `differential` or
`rust` with a plugin set other than the registry the core holds. The registry's
write check now answers its stage as data beside its message so the TypeScript
is compared on structure. The default flip and the TypeScript's deletion are the
next increment.

**Shipped (step 6, S8, stage 4).** The daemon's TypeScript facet write and its
switch are deleted (owner decision q40). `WHITEBOARD_CORE_FACETS` and
`ServerDeps.facetWriteCore` are gone; server-core's `facetWriterFor` answers
only through the core a realm installs (`installFacetWriteCore`), a call the core
declines is a refused write rather than a fallback, and the daemon installs the
core at boot and refuses to start without it. The browser keeps facet-engine's
TypeScript (q47). The record is [the parity checklist](../parity/facet-engine.md).

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

#### The line-breaking spike (2026-11-11): no crate matches; the port does, byte for byte

Risk 4 asked whether a UAX #14 crate with no `line-break: strict` level could
stand in for `css-line-break`, the only line-break call in `canvas-render`
(`uax-segments.ts`: `lineBreak: 'strict'`, `wordBreak: 'normal'`, then a
code-point to UTF-16 walk). The answer is no, and the reason is not strictness.

**What `css-line-break` 2.1.0 is.** A hand-written pair-rule walk over a class
trie, not a table-driven UAX #14 and not conformant to the current one:
- its classes are Unicode 13-era (it knows U+0C77 and U+11FB0, and has no class
  for anything added in 14.0 or later, such as U+061D); `strict` is only CJ
  resolved to NS and the `normal`/`loose` hyphen exceptions left off;
- there is no rule that forbids a break before a combining mark or ZWJ
  (LB9's "x CM" half): a CM is given its base's class and then breaks wherever
  that class may, so `ア` + U+0301 breaks between them and so does any `PO`,
  `PR`, `EB` or `H3` base;
- LB25 is the old subset: no `CL x PR`, `CL x PO`, `CP x PR`, `CP x PO`,
  `PR x OP`, `PO x OP`, `IS x NU` or `SY x NU`;
- LB30 keeps the pre-Unicode-13 shape: only U+2329 and U+FF08 are exempt from
  "letter or digit x OP".

**The candidates**, built as `wasm32-unknown-unknown` cdylibs with the repo's
release profile for size (`opt-level = "z"`, LTO, one codegen unit,
`panic = "abort"`, stripped, no `wasm-opt`), one export over a UTF-16 slice:

| | `unicode-linebreak` 0.1.5 | `icu_segmenter` 2.4.0 | the port (below) |
|---|---|---|---|
| License | Apache-2.0 | Unicode-3.0 | the repo's |
| Both on `deny.toml`'s allowlist | yes | yes | n/a |
| `no_std`, `unsafe` | `no_std`, none, no dependencies | `no_std`; `unsafe` only in the LSTM matrix, which the non-complex constructor does not link; 43 crates in the wasm tree | `no_std`-compatible, none |
| Unicode | 15.0 (knows U+11B00, not U+2FFC) | 18.0, CLDR 49 | 13-era, as the oracle |
| Strictness | none: one behaviour | `Strict` / `Normal` / `Loose` / `Anywhere`, `LineBreakWordOption`, `ja`/`zh` locale | the oracle's |
| Wasm size | 37,134 B (11,662 gz) | 56,470 B (19,388 gz), `new_for_non_complex_scripts`, default features off | 33,561 B (17,054 gz) |

An empty export is 71 B. The port is smaller than either crate because its
table is 3,638 class runs over U+0000-10FFFF packed one per `u32` (14.5 KB);
as `(u32, u8)` tuples the same table makes the module 48,105 B.

**The differential.** One Node process computed `css-line-break`'s internal
break offsets as the TypeScript does (UTF-16 offsets of every segment end but
the last), and a Rust binary computed each candidate's over the same
corpus, compared as exact offset lists per string. Three corpora:
- *main*, 41,401 strings: the 32 pieces of `uax-segments.test.ts`, 3,000
  seeded random joins of them, the 20 text values of the text-wrapping
  scoreboard's 14 cases, and 40,000 seeded strings over a 212-entry
  mixed alphabet (Latin, digits, ASCII and fullwidth punctuation, small kana,
  prolonged sound and iteration marks, kanji, Hangul, Thai, emoji with ZWJ,
  skin tones and regional indicators, currency, percent, combining marks,
  NBSP, ZWSP). 2,193 of them hold a lone surrogate, which a Rust `str` cannot
  carry, so the crates are compared on the other 39,208 and the port, which
  reads UTF-16, on all of them;
- *pairs*, 41,616: every ordered pair of that alphabet's 204 distinct code points,
  the context-free class-pair view;
- *census*, 520,640: every code point U+0020-3FFFF (and U+E0000-E01FF) between
  two kanji and between two Latin letters, the table view.

| Agreement (strings) | main (39,208) | pairs | census | scoreboard text (20) |
|---|---|---|---|---|
| `unicode-linebreak` | 77.96% | 98.81% | 99.95% | 20 |
| `icu_segmenter` Strict | 71.28% | 97.81% | 99.84% | 20 |
| `icu_segmenter` Strict + `ja` | 71.28% | 97.81% | 99.84% | 20 |
| `icu_segmenter` Normal | 35.10% | 90.28% | 99.82% | 19 |
| `icu_segmenter` Loose | 26.12% | 86.75% | 99.82% | 19 |
| the port | 100.00% (41,401) | 100.00% | 100.00% | 20 |

The `ja` locale changes nothing at `Strict`. On the scoreboard's own text the
two strict candidates agree with the oracle on all 20 strings, so a stand-in
would not have moved that scoreboard; what it would move is everything the
scoreboard does not contain.

**The disagreement is the oracle's rules, not the strictness level and not
mostly the Unicode version.** Of `unicode-linebreak`'s 10,250 differing
offsets over 8,642 strings, all but 71 are a break the oracle makes and
the crate does not:
- 4,366 are before a combining mark or ZWJ (`ID|ZWJ` 2,339, `ID|CM` 712,
  `PO|CM` 304, `PR|CM` 281, `EB|CM` 156, `H3|CM` 105, and the same for `RI`,
  `CB`, `CM`, `H2`);
- 5,250 are LB25 pairs, among them (`CL|PR` 1,497, `CL|PO` 912, `PR|OP` 908, `PO|OP` 876,
  `IS|NU` 587, `CP|PR` 222, `SY|NU` 120, `CP|PO` 128);
- 504 are LB30 around U+FF08 and U+2329, and 130 are context effects of the
  rows above (the 71 the crate alone makes among them).
`icu_segmenter` Strict repeats all of it (8,335 of the 8,642 strings fail on
both crates) and adds 2,926 strings of its own, almost all LB30's exclusion of
East Asian wide and fullwidth openers (`a` then `「`: 2,719 offsets
`AL|OP`, 1,282 `NU|OP`) and Thai, Lao, Khmer and Myanmar, which the oracle
never breaks (it reads class SA as AL) and which ICU breaks even without a
dictionary (111 offsets `SA|SA`). The table's version is the small part: the
census differs on 236 strings for `unicode-linebreak` and 832 for
`icu_segmenter`, 0.05% and 0.16% of 520,640, nearly all code points added after
Unicode 13 (U+061D and the 14.0 to 18.0 blocks).

**Verdict.**
- (a) A crate as is: no. The best, `unicode-linebreak`, is wrong on 22% of
  generated strings, and no option of `icu_segmenter` reaches the oracle.
- (b) A crate plus a tailoring layer: not built, and not recommended. The
  tailoring is the five families above, and each is context-dependent: the
  combining-mark rows need the oracle's class folding (a mark takes its base's
  class, `indices` stays at the base for the rule that stops a break at the
  start of text), and the numeric rows need its backward scans. A layer that
  reproduces those is the oracle's algorithm over the crate's table.
- (c) The port: built and measured. `csslb.rs` is 132 lines, one `allowed`
  function holding LB4 to LB30b in the oracle's order and a class pass, over a
  table generated from the oracle's own trie by walking U+0000-10FFFF (3,638
  runs, 54 raw values, the letter-number flag kept so LB8a's raw ZWJ read
  stays exact).
  It agrees on 41,401 of 41,401 (the lone surrogates included), 41,616 of
  41,616 and 520,640 of 520,640. The harness was mutation-checked:
  dropping U+FF08 from LB30's exemption leaves 98.88% on *main*, inverting the
  regional-indicator parity 90.65%, removing the LB9 fold 99.14%, removing
  LB8a's ZWJ check 89.83%, and dropping LB25's closing-punctuation look-behind
  99.53%. One mutant survived, the upper bound of the unassigned-plane
  default to ID, as an equivalent mutant: the trie already says ID there.
- (d) A pinned diff: only for the later move below.

**Recommendation: (c).** Step 7's gate is identity ("SVG golden byte-identical
on TypeScript, native and wasm"), the port reaches it with no TypeScript
change and no golden moved, and it is smaller than either crate. Three
consequences:
- The table is generated, never typed, from `css-line-break`'s trie by a
  script that runs while the TypeScript still exists, and the gate is a
  recorded oracle (decision 4) of the three corpora's answers, as the
  frontmatter's is; the census is regenerated from the table rather than
  recorded.
- After the TypeScript is deleted the port is the specification, holes
  included. Its header says so, and the holes are a ledger entry: the missing
  `x CM` rule, the LB25 pairs above, LB30's East Asian exemptions and a table
  that stops at Unicode 13.
- Moving off those holes is one conscious later decision, taken on both sides
  at once, because the gate is identity: `icu_segmenter` (97.81% of generated
  strings, 18.0) or a corrected fork of the oracle, vendored the way BudouX is,
  with the goldens moved once under a ledger (decision 4). It is not on step
  7's path. Its price is the 22% to 29% of random mixed strings that differ at
  some offset, mostly marks and numbers, and the Thai behaviour above.

**BudouX** (`vendor/budoux`, 82 lines plus a 1,678-entry integer model) is a
model-table walk and ports as generated data. For each UTF-16 index it sums
13 weights looked up by a one-, two- or three-unit substring of its
neighbourhood and cuts when the sum exceeds half the total of all weights;
every weight is an integer, so the comparison is exact in doubled integer
arithmetic. The Rust side is the same walk over `u16` slices with the model as
a sorted static array per feature group (substrings that split a surrogate pair
stay representable), generated from `ja-model.ts` by the same script that
dumps the trie. Not measured here: the effort is estimated at half a day, gated
by the same differential over the kana strings of these corpora.

**What stays open.** The wrapping scoreboard and `inline-junction` were not
re-run with the port behind them (their one reader is `uaxSegments`, which the
differential covers offset for offset); the spike's harness is throwaway and
step 7 rebuilds it as the recorded oracle; the Unicode version of the oracle's
tables is bounded by probes (13-era), not read from a header, as the package
carries none.

Step 7 slice S5 landed the port as `crates/core/canvas-render/src/linebreak`
over a table generated from the trie (3,638 runs, 54 raw values), with the
harness rebuilt as the recorded `linebreak.jsonl`: small corpora string by
string, and digests of the three large ones (every ordered triple of class
representatives, 200,000 seeded mixed strings, a census of U+0020-1FFFF
between two kanji and two Latin letters, and the raw class of every code
point) that the Rust test regenerates from the recording's `meta` record.

Step 7 slice S7 ported the text primitives (`uax_segments`, `longest_fitting_count`,
`fit_to_width`, the inline junction) over the `Measure` trait, held to the
recorded `text-primitives.jsonl`. The grapheme cut uses `unicode-segmentation`
1.13.3 (Unicode 17) against Node 24's `Intl.Segmenter`: the two agreed on every
string of the census (every code point between two letters and after a Devanagari
conjunct, every ordered triple of 60 grapheme-break representatives, and the
corpus), so no deviation is ledgered. A `&str` holds no lone surrogate, so the
`fitToWidth` and junction answers for one are not reproduced; `uax_segment_ranges`
takes UTF-16 units and is held on them.

Step 7 slice S9 ports the markdown typesetter (`mdast-blocks.ts`) in sub-slices, each held to a
recording of `typesetMdastBlocks`'s scene (every double as its bits) and of how many times it
asked the measurer. The input is a model mdast tree, a plain type in `whiteboard-model`
(`mdast`); what the host knows (emoji and icon shortcodes, titles, embed names, a picture's
source) is asked through `InlineSeams`, answered in the recording from tables the TypeScript
filled. S9a is the inline layer (wrapping by UAX #14 and BudouX, kinsoku across inline junctions,
atomic runs cut to the width, links with provenance, hard breaks) with the paragraph and heading
blocks; S9b adds the childless blocks (rule, raw html, definition, display math, fenced code) with the highlighter and the math and diagram renderers as traits answered from recorded tables. S9c adds the blockquote, the list with its task boxes, the table and `select_markdown_section`; the list item and the table cell keep their children relative to the wrapper, as the backend's translate reads them. S9d adds the embed paragraph: a document is laid out in place with its blocks absolute, a canvas is a framed panel around the host's picture, and a cycle, the depth cap, the nested-layout account, a pending target and a missing fragment each end in the TypeScript's panel or placeholder. Every block is carried now, so `typeset_mdast_blocks` returns a scene and the interim `Unsupported` result is gone. S9e adds the cuts a node's body is trimmed to (`fit_blocks_to_height`, `first_line_of_blocks`, with `markLastRun`), replayed from recorded bodies as data.
Step 7 slice S11 ports what the composer draws for one node in sub-slices (S11a to S11d). S11a is the node box (`node_box`): the content bounds a silhouette inscribes, the padding and content width, the chrome with its sketch ink, the label run, content placed in a node, above it and fitted to it, with `translate_scene` and `seed_from_id` beneath them, held to the recorded `node-box.jsonl`. The silhouette a node resolves to and where a plugin places its text are asked of the host (`NodeBoxHost`), answered in the replay from the recording. The recording also holds each node's label, which S11b's `label_of` reproduces from the node and its resolved reference. S11b is the node readers (`node_content`) and what the composer draws for a text, frame or link node (`compose_node`): the body typeset at the content width with the active theme's markdown chrome, cut to the box but never below one line, cached under the TypeScript's own key unless the render's nested-layout budget refused something for it; an empty frame's tint and its background picture; the lock badge; and the dispatch by kind, held to the recorded `compose-node.jsonl`. The body parser (with its reference resolution), a reference's resolution and the comment layer's passage highlights are asked of the host (`ComposeHost`); degradations are reported to it rather than logged. S11c is the file node: its reference resolved once, then the picture filling the padded box, the canvas embed, the referenced document's body with its name above the frame, and the facet card (a heading and `label: value` rows, blank ones dropped as `String.prototype.trim` reads blank) laid out as a body, in rank order, with the label inside the chrome when none draws. A body is fitted by `fit_body_in_node`, which refuses a box with no room before measuring. A caller's mdast tree is typed in Rust, so the TypeScript's guard against a malformed one throwing from the typesetter has nothing to catch. S11d draws a canvas inside another document: a file node's canvas, behind the expansion policy, the depth cap of 3, a path-local cycle check and the render's nested-layout account (charged by the canvas's nodes, edges and lines before a fit with no room can still pass it to the body, as the TypeScript charges it), and a body's `![[canvas]]`, which the composer draws as the typesetter's `CanvasMiniature`. Both are the canvas laid out at its own size by the host's composer (`layout_nested_canvas`) and fitted by `fit_scene_into_box`, never scaled up; the fit's scale is finite and in (0, 1] by construction, so `scaleScene`'s guards against any other factor are not ported. The decoration pass (`compose_decorations`) asks every contribution in order and appends what each draws (owner decision q69): a decoration implements `whiteboard-scene`'s `NodeDecoration` trait, the TypeScript's `NodeDecoration`, told the node and a `DecorationContext` (its content bounds and the label's appearance), so the renderer names no plugin. The visual plugin's `StencilBadge` implements it beside its silhouettes and is the contribution a composer passes by default; it reads the stencil and symbol a node wears through the plugin's own `NodeMarks`, which the host answers until their facet readers are ported. A body's canvas target is asked of the host too (`embedded_canvas`), since the typesetter's resolver keeps only its size.
Step 7 slice S13 ports the composer over a whole canvas in sub-slices. S13a is what its edge pass reads of a silhouette (`node_outline`): `outline_contains`, the hit test over the bundled plugin's outlines (an ellipse, a convex polygon of either winding, the cylinder's lid and bulge), and `outline_entry_point`, which pulls a route's terminal inward along its approach to the boundary that hit test answers for, by a 32-step bisection; held to the recorded `node-outline.jsonl`. The anchoring's guards against a box or a terminal that is not finite, a non-finite span and a zero direction are not ported: no point is inside a box that is not finite, a terminal that is not finite is inside nothing, and a probe that is not finite lands at no finite point, so each answers the terminal either way.
S13b is the edge pass (`compose_edges`), held to the recorded `compose-edges.jsonl`: the canvas's edges and then its lines handed to `route_layout` in one call, ids interned as the wasm shim interns them, an element's routing its own `visual.edges` facet, else the canvas's, else the theme's default, else straight; each route weighed by its `visual.stroke`, inked under a sketch theme and pulled onto the silhouettes of its ends (S13a's `outline_entry_point`, the arrival end first); the hops put on the elements that draw them; and a label placed at the drawn line's midpoint or slid along or off it clear of every box and frame title (`edge_label_placement`). The plugin's edge facets (`EdgeFacets`) and the hops (`EdgeJumps`, `computeEdgeJumps`) are asked of the host until S13d and S13c port them.
S13c ports `computeEdgeJumps` into `whiteboard-edge-routing` in two. S13c1 is its broad phase (`edge_jumps::grid`), held to the recorded `edge-jump-grid.jsonl`: `place` files a run at the finest level from 4^-30 whose cell holds its extent, `SegmentGrid` gives each level the bounds of its own runs and answers which levels a run reaches (its own, and every coarser one whose bounds it comes within a pad of), the cells of its line there, the runs filed in those cells (finer ones only at its own level) and the work counted against the 4,000,000 budget, past which it answers none. The TypeScript's `log2` first guess at the level is not ported: it corrects the guess both ways to the same smallest level, so Rust searches for it directly. Its skip of the column clip for a run inside one column IS ported: in range the clip changes nothing, but at the top of the range the column's left edge overflows and the clip collapses the run's rows, a case the recording holds (`far`'s last outlier). S13c2 is the rest (`edge_jumps::compute_edge_jumps`), held to the recorded `edge-jumps.jsonl`: an edge's straight runs (a waypoint continues a run only where it carries on along one axis, forward, by exact comparison), each run's crossings with the earlier runs the grid hands it, the path segment that carries each with a hop's clearance on both sides, the hand-over to the earlier edge where the later one's split leaves it no room (kept only when it is a hop of its own once that segment is spaced again), the spacing of a diameter, and the caps of 64 hops a segment and 4096 a scene. `crossingsOn`'s distance along the run is not ported, since nothing reads it, nor `placedRunsOf`'s finite-point check, since `place` files no run with a non-finite end. The edge pass now computes its hops itself and the `EdgeJumps` seam is gone; `compose-edges.jsonl` had recorded the TypeScript's real hops, so it stands unchanged and its replay compares them with the Rust's.
S13d ports what the composer reads of the facets. facet-engine's registry gains the compat chain (`resolve_facet_payload`, the TypeScript's `resolveFacetPayload`), held to the recorded `compat.jsonl`: a malformed key is dropped, an unregistered one passes through, a newer version is preserved, the current one is parsed, and an older one is parsed by its retained schema and walked forward one compat step at a time, versions compared as numbers. A manifest's `compat` entries are decoded and their migrations are the host's, supplied by name beside the plugin's files; the walk takes at most one step per entry, so a version past 2^53, where the TypeScript's walk never ends, is dropped. plugin-visual's facet readers (`read`: shape, text alignment, edges, stroke, theme, stencil, symbol) read a facet bucket through it, held to the recorded `facet-read.jsonl`, and `StencilBadge` reads the stencil and symbol a node wears through them, so `NodeMarks` is gone. In canvas-render the silhouette each node resolves to is data, as the TypeScript's `nodeOutlines` is (`NodeOutlines`, filled by `resolve_node_outlines`: a node's own `visual.shape` under the plugin's namespace, else the theme's default for anything but a frame); text placement is the node's own `visual.text`; and the edge pass reads `visual.edges` and `visual.stroke` itself, so `NodeBoxHost` and `EdgeFacets` are gone. `node-box.jsonl` stands unchanged; `compose-node.jsonl` and `compose-edges.jsonl` gained the facets their wires had left out, every answer byte-identical.

S13e ports the composer's walk over a whole canvas (`compose_canvas`), held to the recorded `compose-canvas.jsonl`: `layout_spatial_canvas` colours a canvas by intent first (an uncoloured node or edge takes the one colour its scoped tags declare in the caller's tag library), settles its theme (none when the style is clean, the canvas's own under the document style, else the theme of the canvas it is embedded in, a named one otherwise) and with it the appearance, the declared face and each node's silhouette, then draws every node in paint order (frames first, larger before smaller) with its decorations, tinting a frame that holds nothing, then every edge and line, then asks an `Overlays` seam for the comments, proposals and legend that S13f to S13h port. A file node's canvas and a body's `![[canvas]]` are laid out by the walk itself, which retires `ComposeHost::layout_nested_canvas`; `empty_frame` retired with it, and suppressed bodies and locks became option sets. `layout_spatial_edges` and `natural_node_content_size` go through the same colours and theme, and a property holds the first equal to the whole layout's edge suffix, which a live drag relies on.
BudouX reads UTF-16 units and can name a phrase boundary inside a surrogate pair; the
TypeScript used to break there and leave half an emoji in a run, which was a defect. Both sides
now join such a phrase to the next, so there is no deviation to ledger.

#### The measure-seam spike (2026-11-11): the callback is cheap, the memo is what pays

Step 7 moves layout behind the core, and layout never measures text itself:
it calls an injected `measure(text, font)`. Seam 1 says text measurement lives
inside the core (a font-table measurer) with a host callback kept as a port, in
a fixed shape, and rejected a per-run callback as "the hottest boundary in the
system". The spike measured that claim, and the other two ways a host could
answer (a pre-measured advance table, a batch), on the real layout.

**What layout asks.** 14 corpora x 3 widths in the text-wrapping scoreboard,
and four canvases laid out through `layoutSpatialCanvas` with the fake
measurer. The canvases are 60 nodes with 40 labelled edges, and 288 nodes
with 60, with markdown bodies, plus two label-overflow benches. A
distinct-prose variant (words drawn from a list of about fifty) has a lot less
repetition than the first, whose six sentences recur.

| Workload | Calls | Unique (text, font) | Mean length (UTF-16) |
|---|---|---|---|
| Scoreboard, 42 cases | 812 | 580 (71%) | 11.7 |
| 60 nodes / 200 edges, repeated sentences | 3,980 | 295 (7%) | 16.8 |
| 60 nodes, distinct prose, no edges | 4,684 | 2,402 (51%) | 21.3 |
| 288 nodes / 345 edges, repeated sentences | 19,348 | 771 (4%) | 16.7 |
| 288 nodes, distinct prose, no edges | 22,857 | 6,711 (29%) | 21.5 |
| bench: 480 labels `n<i>` | 1,440 | 481 (33%) | 2.8 |
| bench: 480 overflowing labels | 11,520 | 490 (4%) | 20.1 |

In the 60-node case 640 calls are a single character (the space), the median
is 13 units, the 90th percentile 31 and the longest 142, in five fonts. Layout
asks for words, line prefixes and labels, never single glyphs. Roughly 24 calls
per overflowing label are the `fitToWidth` bisection.

**The demand is not knowable ahead of the answers.** Wrapping probes joined
prefixes of segments with a search that starts from the previous line's count,
and truncation bisects a prefix length, so each probe is chosen from the last
answer. A pass with a 0.5-per-character stand-in measurer predicted 299 of the
580 unique keys the scoreboard's measurer asked for (52%). Running layout
repeatedly, answering what each pass missed, until a pass asks nothing new
took 4 rounds on the repeated-sentence canvases and 7-8 on the distinct-prose
ones (counting the final pass that asks nothing), and requested 4-10% (30
keys on each) and 53-56% (3,755 against 2,402; 10,293 against 6,711) more keys
than layout needs. A two-pass batch would
re-run layout once per round.

**A table cannot be exact in general.** `describeMeasureTextConformance`
holds a measurer to additivity within 0.01 px, not bit for bit. Summing
per-unit advances against the fake's `len * 0.6 * size` differs in the last
bit on 2,600 of 3,980 strings (65%); the scoreboard measurer's
`(sum of em) * size` against a sum of `em * size` differs on 240 (6%). A table
reproduces a measurer only by repeating its arithmetic order, including the
64-code-point segment sums `measureCarriedRun` makes for long runs, and it
cannot reproduce Canvas `measureText` at all.

**The boundary.** A release-built wasm crate (wasm-bindgen 0.2.130, LTO),
Node 24.22.1, 3,980 calls replayed from the 60-node layout, median of seven
timed runs, the host answering with the fake's arithmetic:

| Shape | ns per call |
|---|---|
| JS calling a JS closure with the same arguments | 8 |
| Rust calling an imported function, two integers | 8 |
| imported function `(text: &str, font_id: u32) -> f64` | 145 |
| imported function `(text: &str, font: &str) -> f64` | 260 |
| `js_sys::Function::call2` with strings, number back | 375 |
| `js_sys::Function` returning `{advanceWidth, ascent, descent, lineGap}`, read with `Reflect::get` | 736 |
| one call: all 3,980 strings joined with `\n`, a `Float64Array` back | 73 per string |
| Rust memo keyed `(font id, text)`, hit path (it clones its key) | 48 |
| the same memo, one cold layout (93% hits) | 77 |

The crossing itself is free (8 ns); the cost is the string, which wasm-bindgen
decodes from linear memory on every call (mean 21.7 UTF-8 bytes), and a font
passed as a css string adds as much as the text does. The object answer is the
expensive shape. Ascent, descent and line gap are properties of the font in
both real measurers, so they need cross once per font.

**Against the layout.** On the same machine the TypeScript layout of the
60-node canvas takes 471 ms with its 200 edges and 66 ms with none; the
288-node canvas 1,414 ms and 292 ms. (The edge search is the ADR's 332-339 ms
figure plus the text.) Callback overhead per layout:

| Workload | Calls | `(text, font id)` | `Function` returning an object | Text-only TypeScript layout |
|---|---|---|---|---|
| 60 nodes | 3,980 | 0.6 ms | 2.9 ms | 66 ms |
| 288 nodes | 19,348 | 2.8 ms | 14.2 ms | 292 ms |

The cheap shape costs 1% of the text layout; the object-returning closure 4-5%.
Neither moves a layout whose edge search is 80-86% of the time. That is a
number about the call. The measurer behind it matters more: opentype.js
`getAdvanceWidth` (vendored Roboto, kerning off) took 134 us per call on the
3,180 Latin strings of the 60-node replay, 0.53 s for the 3,980 calls against
0.04 s for the 295 distinct ones. Neither the TypeScript layout nor either real
measurer memoises: `canvas-render` has no measure memo, and neither real measurer does; only `use-drag-layers.ts` keeps a per-gesture map, and a live drag
measures one string per labelled edge (`layoutSpatialEdges` composes edge
labels only). The per-node `contentCache` skips unchanged nodes entirely. So a
memo inside the core would cut host work by the factor in the "Unique" column,
which is a gain on the TypeScript layout too.

**Verdict.** Seam 1 stands, and it is the table that carries it:
- The production measurer is the in-core `FontTableMeasurer` of seam 1. This
  spike did not build it, so its own cost is unmeasured here; its arithmetic
  must follow the TypeScript measurer's order to be differential against
  `mcp-server`'s. Against Canvas, 0.01 px of advance width (and the suite's
  1 px for vertical metrics) is the target it must be checked against, not a
  result this spike measured.
- **The core measures through a `Measure` trait.** Three implementers:
  the font table; a native fake whose arithmetic is the TypeScript fake's
  (`len_utf16 as f64 * factor * size`, IEEE-identical, no callback); and
  `HostMeasure`, a wasm-only callback for system fonts. All three goldens
  target the deterministic fake, so byte identity is about the algorithm and
  never needs a host. The daemon's native build uses the font table or the
  fake and never sees a callback, so the trait is the seam and the callback is
  one implementer.
- **The callback keeps seam 1's fixed shape, with two corrections.** Fonts
  cross as an interned id (the font table registered once per layout, the
  per-font ascent, descent and line gap with it) and the call answers one
  `f64` advance: 145 ns, against 260 for a css string and 736 for an object.
  Answering vertical metrics per font is a compatibility decision, not a
  free one: `MeasureText` lets ascent vary by text and layout takes each
  run's baseline from it. The browser measurer already answers the font's
  box (`fontBoundingBoxAscent`) and falls back to the text's own
  (`actualBoundingBoxAscent`) only on an engine without it, and the fakes and
  `mcp-server`'s measurer answer per font; so the per-font shape changes a
  baseline only on that fallback, where the core's answer becomes the font's
  box. A host that needs per-text vertical metrics takes the object-returning
  shape, at its measured 736 ns.
  `measure_batch` is dropped from the fixed shape: a layout cannot
  enumerate its demand (52% predicted, 4-8 rounds), and 73 against 145 ns per
  string saves under 0.3 ms a layout. It returns only if a host's per-call
  cost is a thread hop rather than a V8 import.
- **The memo is per layout and lives in the core**, keyed `(font id, size,
  text)` as seam 1 says, over every implementer. It is sound only inside a
  layout, since a face loading mid-session changes the answers, so
  cross-layout caching stays the host's (the drag map, the content cache).
  A cross-layout seed would need a font-identity key, which is not a step 7
  need.
- The per-call callback costs 0.6-2.8 ms a layout and the memo cuts the calls that
  cross by 29% to 96%. The "hottest boundary in the system" claim does not survive as a
  speed argument, so the reason to keep text measurement inside the core is
  determinism (Context, point 4: the guarantees the project sells are determinism guarantees), the reason seam 1 also gave.

**Not measured, and what it could change.** No browser ran here, so Canvas
`measureText`, and wasm-to-JS import costs in Firefox and Safari, are open: a
`measureText` of several microseconds would make the memo matter more, and a
slower import would make the font-table path matter more, and neither
reverses the verdict. The distinct-prose canvases are synthetic; real
documents repeat words less than the first set and more than the second, so
read the memo's saving as between 29% and 96% of calls. opentype.js was timed
directly, without `mcp-server`'s glyph-index scan, on one machine and one run
of seven. The wasm crate was throwaway and is deleted; the call-sequence
replay and the counting harness are not kept in the repository.

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
   memoising by `(FontId, size, text)`, one `f64` advance per call (the
   measure-seam spike, 2026-11-11, dropped the `measure_batch` this seam first
   named: a layout cannot enumerate its demand). Browser and daemon then
   measure identically by construction.
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
   - every object declares `x-wb-unknownKeys: refuse | strip | keep`; strict types
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
| 3 | `rust` | Rust answers; TypeScript is still present, so rollback is flipping the switch back | one release with no mismatch reported; by default the TypeScript is deleted in the next release (owner decision q40, 2026-11-10: as soon as the migration is complete), later only with a recorded reason |
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
| 6 | `model`, `facet-engine`, `scene`, `codec`, `plugin-visual` data half | the OKF round trip (frontmatter plus a verbatim body) answers the same bytes from Rust as from the TypeScript for the same input; the restricted frontmatter parser differentially fuzzed against npm `yaml`, with zero disagreement once the TypeScript refuses the same subset. Markdown stringify stays in TypeScript until it has a caller (both spiked 2026-11-09, above) |
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
| 3 | Markdown/YAML parity: markdown-rs parses, but there is no remark-stringify twin; the YAML crates are archived or unsound | The restricted frontmatter parser, differentially fuzzed against npm `yaml` (decision 25); stringify spiked before step 6 (2026-11-09: the closest twin matches 89.6% without references and needs a fork, and the writer has no production caller yet) |
| 4 | Line breaking: `css-line-break` strict (CSS kinsoku) against a UAX #14 crate with no strictness levels | Spiked 2026-11-11: no crate matches (`unicode-linebreak` 78%, `icu_segmenter` Strict 71% of generated strings; the gap is the oracle's own rules, not strictness); a 132-line port over a generated table matches 100% on 603,657 strings, so step 7 ports it and a move to a conformant breaker is one later ledgered decision |
| 5 | Highlighting has no Rust twin of highlight.js | Host seam through the transition |
| 6 | Two loro engines: size, version pin, `_utf16` APIs | One-cohort migration; lock-step guard |
| 7 | Workers: script size; CPU time for large layouts | Size ledgers per artifact; measured CPU per layout size |
| 8 | Live-drag boundary cost | Measure first; typed-array fast path kept available (2026-11-11: a drag measures one string per labelled edge, and a wasm-to-JS callback is 145 ns with a font id; the measure seam is not the drag cost) |
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
