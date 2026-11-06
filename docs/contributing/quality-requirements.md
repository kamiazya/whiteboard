# Development quality requirements

The quality bar every change to this repository is held to, written once and
independently of the language the code is in. It exists because the core is
moving from TypeScript to Rust ([ADR-0054](adr/0054-rust-core.md)), and a bar
that lives only in TypeScript tooling would silently not apply to the new
code — or would be re-invented per crate, differently each time.

**Status of the two columns.** The TypeScript column describes what runs
today, with the paths that implement it. The Rust column is the REQUIRED
mechanism for Rust code; at the time of writing no crate exists yet, so every
Rust entry is the specification a crate must meet when it lands, not a claim
that it already runs. A Rust job is not "done" until it runs in CI, feeds
`ci-gate`, and has been mutation-checked (it was shown to fail on a planted
defect).

**Keywords.** MUST and SHOULD as in RFC 2119. A SHOULD that is not followed
says why in the PR body.

**Gate levels.**

| Level | Meaning |
|---|---|
| **G** | Blocks merge, through the aggregate `ci-gate` check (`tools/checks/src/ci-gate.mjs`) |
| **PP** | Pre-push, through `lefthook.yml` |
| **PC** | Pre-commit, through `lefthook.yml` |
| **R** | Report-only: runs, publishes a result, blocks nothing |
| **S** | Scheduled (cron), report-only unless stated |
| **P** | Process: enforced by review, the dev-loop checkpoints, or a harness hook — not by a job |
| **Rel** | Release path only |

The local pre-push gate runs no test suite (owner decision, 2026-09-05): the
dev loop runs the nearest layer, and CI runs everything. Rust adds
`cargo fmt --check` and `cargo check` to pre-push and nothing slower.

---

## 1. Static correctness

| QR | Requirement | Guards against | TypeScript today | Rust | Gate · where |
|---|---|---|---|---|---|
| **QR-1** | Code MUST compile with every warning an error, and MUST pass the project linter with no warning. | Type errors; general lint classes; the type check being the only reader of types (vitest strips them) | `tsc` strict per package (`strict`, `noUnusedLocals`, `noUnusedParameters`, `noFallthroughCasesInSwitch`) via `pnpm -r typecheck`; Biome `recommended` with `--error-on-warnings` (`biome.json`) | `cargo clippy --workspace --all-targets -- -D warnings`; `[workspace.lints]` in the root `Cargo.toml` with clippy `pedantic` at `priority = -1` and selective allows; `cargo fmt --check` | PP + G (`check` job; Rust job) |
| **QR-2** | Tests MUST be compiled and type-checked with the code they test. | A package whose type check omits its tests ships untyped tests | `tools/arch-lint/src/tests-are-typechecked.test.ts` | `--all-targets` on every `cargo check`/`clippy`; `cargo test --no-run` in the test job | PP + G |
| **QR-3** | Dead code, unused exports and unused dependencies MUST fail, or be registered as intentional with a reason. | Code kept alive only by its own test; barrels nobody imports through; undeclared or unused dependencies | `pnpm knip` (`knip.jsonc`, `--treat-config-hints-as-errors`, `includeEntryExports`); `test-only-exports.test.ts`, `reexport-importers.test.ts`, `undeclared-runtime-deps.test.ts`, `no-test-utils-in-production.test.ts` | `dead_code`, `unused_imports`, `unreachable_pub` denied; `cargo machete`; test doubles behind `#[cfg(test)]` or a `test-utils` feature that no binding enables | G (`verify`; Rust job) |
| **QR-4** | A concept MUST have one definition, enforced mechanically; every text scan (one-place, vocabulary, comment hygiene, sizes, sleeps, CODEOWNERS) MUST cover Rust source and MUST assert its subject is present. | A rule re-implemented N times and drifting; a scan whose glob matched nothing reporting "clean" | ~45 `tools/arch-lint/src/*-one-place.test.ts`; `vocabulary-check.test.ts`; `comment-file-pointers`, `comment-identifier-pointers`, `comment-chronology-phrases` tests; non-empty guards `repo-coverage.test.ts`, `scan-roots`, `workspace-scan-coverage` | The same scans with roots extended to `crates/**/src/**/*.rs`; structural single definition (one crate or module, `pub(crate)`) where possible; `cargo doc` with `-D rustdoc::broken_intra_doc_links` for identifier pointers | PP + G (`arch-lint-node`) |
| **QR-5** | The toolchain MUST be pinned in one file and agree everywhere it is named. | A wrong compiler or runtime major producing failures that do not name it | `.node-version`; `node-pin-agreement.test.ts`; `local-node-version.test.ts`; root `globalSetup` banner | `rust-toolchain.toml` (channel, `wasm32-unknown-unknown`, clippy, rustfmt, llvm-tools); `wasm-bindgen-cli` pinned equal to the `wasm-bindgen` crate and checked; an agreement test over CI's toolchain steps | G |

## 2. Contracts and the neutral schema dialect

| QR | Requirement | Guards against | TypeScript today | Rust | Gate · where |
|---|---|---|---|---|---|
| **QR-6** | Every cross-process contract (MCP tool I/O, HTTP routes, persisted JSON, sync frames, the daemon registry) MUST have ONE schema; every type in every language MUST be generated from or inferred from it, never written in parallel. Drift MUST be caught three ways: the generator's `--check` with `git diff --exit-code`, generated output checked in, and a round-trip property. | Schema vs hand-written type drift (`create_frame`'s `assignedMembers: number` against `string[]`); runtime drift the type system cannot see | Zod as source; `z.infer`; `registerToolWithAnnotations` generic over the output schema; `pnpm smoke:e2e` (`packages/mcp-server/scripts/smoke/mcp-e2e-smoke.mjs`) validating `structuredContent`; `packages/codec/src/spatial/json-schema.test.ts` (generated artifact file-snapshot) | Neutral JSON Schema under `contracts/`; `cargo xtask codegen --check` emitting Zod SOURCE (`packages/*/src/generated/*.zod.ts`) and serde types (`crates/*/src/generated/*.rs`); the round-trip property — fast-check draws from the generated Zod, wasm parses and re-serialises, deep-equal | G |
| **QR-7** | Contracts MUST be written in the restricted dialect: JSON Schema 2020-12; no bare `maxLength` (`x-wb-maxUtf16`); portable `pattern`s compiled by both engines in CI; `x-wb-unknownKeys: refuse \| strip` on every object; no implicit null; integers within ±2^53; `description` on every tool parameter; refinements as named `x-wb-check` predicates; brands as `x-brand`; no transforms. | Three length units in play (code points, UTF-16 units, UTF-8 bytes); a regex that means different things in two engines; a refinement validated on one side only; ADR-0031's scoreboards losing `.describe()` | Zod conventions: `utf16Max()` (`packages/model/src/utf16-max.ts`); `.strict()` requests | A dialect validator in the `xtask` that refuses any construct outside the dialect; each `x-wb-check` implemented once per language and held equal by the differential (QR-21) | G |
| **QR-8** | Requests MUST be strict and answers tolerant; persisted JSON MUST be hydrated through the schema, never cast. | A browser breaking on a new daemon field; a daemon accepting junk; casted JSON corrupting state | `api-contract-response-tolerance.test.ts`, `api-contracts-barrel.test.ts`; `schema.parse(...)` rule in AGENTS.md | `deny_unknown_fields` on request types only, generated from `x-wb-unknownKeys`; validating deserialisation for persisted shapes | G |
| **QR-9** | Property-test generators MUST be derived from the schema, and an unmodelled construct MUST be a hard error. | Property inputs lagging new schema fields | `packages/model/src/test-utils/zod-arbitrary.ts` (`arbitraryForSchema`); `canvas-render/src/test-utils/facet-arbitraries.ts` | proptest strategies generated from the same schema by the `xtask` (or `proptest-derive` on generated types), unknown construct refused | G |

## 3. Architecture boundaries and the single architecture map

| QR | Requirement | Guards against | TypeScript today | Rust | Gate · where |
|---|---|---|---|---|---|
| **QR-10** | There MUST be one architecture map for both languages, declaring per entry its language, layer, targets, what it absorbs, its status, and each allowed third-party dependency with a reason. Dependency direction, the allowed-third-party record and package cycles MUST be checked against it, guarded from both sides (a stale entry fails too). | Reverse or cyclic dependencies; unvetted dependencies breaking a runtime or the published build; allowlists outliving their debt | `tools/arch-lint/src/architecture-map.ts`; `direction-check.ts`, `source-direction-check.ts`, `allowed-deps-check.ts`, `package-cycle-check.ts` | `architecture-map.json`; `cargo xtask arch-map` over `cargo metadata` (each member's dependencies equal its allowed set, in layer order; dev-dependencies exempt from direction but in the cycle check); cargo-deny `[bans]` with `wrappers` restricting tokio, hyper, getrandom and rusqlite to named bindings and mechanics | PP + G |
| **QR-11** | Core code MUST run unchanged on every target runtime and MUST have no route to the OS except through ports. | Shared code that compiles everywhere and fails at runtime somewhere (`std::fs` compiles on `wasm32-unknown-unknown` and fails when called) | Boundary scan for `node:*`, DOM globals and `inversify` (`scanner.ts`, `scan-packages.ts`'s `SHARED_LAYER_PACKAGES`) | `crates/core/clippy.toml` `disallowed-methods`/`disallowed-types` (fs, net, process, env, thread, `SystemTime`, `Instant`); core built for `wasm32-unknown-unknown` and its import section scanned (`cargo xtask wasm-imports`, wasmparser): a core wasm MUST import nothing | G |
| **QR-12** | Layering inside a composition root MUST be enforced: an adapter (route, tool registration) never reaches a mechanic (store, daemon, export); work a process does on its own MUST be declared, with its cost, before it is armed. | Adapters doing mechanics' work (ADR-0018); workers running on every instance or blocking the serving loop | `adapter-mechanic-check.ts` (allowlist pinned by equality); `mcp-server-layer-order.test.ts`; `background-work.ts` registry, `background-work-costs.ts`, `background-work.guard.test.ts` | Structural: `adapters` crates cannot depend on `mechanics` (QR-10's map); background work declared in `ops` as a typed registry and armed in the binding; stall ceilings measured from tokio runtime metrics | PP + G |

## 4. Unit testing, conformance and isolation

| QR | Requirement | Guards against | TypeScript today | Rust | Gate · where |
|---|---|---|---|---|---|
| **QR-13** | Every change MUST start with the smallest failing test at the nearest layer. A test-selection filter MUST NOT pass silently when it selects less than intended. | Implement-then-test; over-broad E2E; a mistyped `--project` running fewer tests and exiting 0 | AGENTS.md; `test-layer-selection` skill; `vitest.projects.json` with `vitest-project-names-referenced.test.ts`, `package-test-script.test.ts` | `cargo nextest` with a workspace-wide profile; the CI job asserts an expected test-count floor per crate so a filterset that matches nothing fails | P + G |
| **QR-15** | Every implementation of a port MUST run that port's shared conformance suite, and a ledger MUST force it to. A surface that grows (verbs, commands, refusal codes) MUST be enumerated exhaustively so member N+1 cannot go unmodelled. | Implementations of one port diverging; a new member silently untested | `packages/ports/src/test-utils/*-conformance.ts` with `port-conformance-ledger.test.ts`; coverage ledgers (`apps/web/src/test-utils/coverage-ledger.ts`, `.claude/rules/coverage-ledger.md`) | A trait-parameterised suite (generic test function or macro) run by every Rust implementation and, through the wasm binding, by every TypeScript one; an exhaustive `match` with no `_` arm as the compile-time ledger | G |
| **QR-16** | A test whose premise the environment cannot establish MUST skip by probing, and the probe MUST hold on CI. A test MUST fail on an error it did not expect to be logged. Tests MUST NOT share mutable state or a data directory. | A skip that reads as a pass; a swallowed exception breaking a later unrelated test; cross-test leakage | `CAN_DENY_FILE_READ` in `packages/mcp-server/src/shared/test-utils`; `expectLoggedFailure` (`apps/web/src/test-utils/logged-failures.ts`); `captureLogsForTests`; `vitest-data-dir.test.ts`; `test-temp-dir-cleanup.test.ts` | `#[ignore]` only behind a runtime probe with a CI assertion that it holds; a capturing log sink that fails the test on an unclaimed `error`-or-above record; `tempfile::TempDir`; nextest's process-per-test isolation | G |

## 5. Property-based and model-based testing

Property tests are where this repository's tests do most of their work — 217
test files import fast-check — and they are the instrument the TypeScript
oracle and its Rust port are compared with, so they get requirements of their
own rather than a row under "testing". The how-to, with the worked cases, is
the `testing-techniques` skill's
`.claude/skills/testing-techniques/resources/property-and-mutation.md`; the
layer budgets are the `test-layer-selection` skill's.

| QR | Requirement | Guards against | TypeScript today | Rust | Gate · where |
|---|---|---|---|---|---|
| **QR-14a** | A property or model-based test is REQUIRED (in place of, or beside, an example test) when a change touches: a parser or serialiser — a round-trip property (`parse(serialise(x))` equals `x`, or an explicitly computed normalisation of `x` when the serialiser is not injective) PLUS a totality property (parse either refuses or returns a schema-valid value, never a silent coercion); a state machine with time, TTL or revocation; a concurrent store (N writers converge on one agreed result); a CRDT or other mergeable structure (idempotence, commutativity, convergence); a rounding or normalisation transform (its algebraic invariant, e.g. `normalize(normalize(x)) === normalize(x)`). Example and browser tests remain the choice for UI wiring and one-off integrations with no invariant to state. | Bugs only an unanticipated input or ordering reaches; a serialiser that silently loses or coerces | AGENTS.md "Test Layer Selection"; `test-layer-selection` skill; `*.property.test.ts` (about 83 files by naming across web, `mcp-server`, `loro-adapter`, `codec`, `model`, `canvas-render`, `server-core` and others) | proptest for every listed class in the crate that owns the code; codec round-trip and totality properties per format (OKF, JSON Canvas, OCIF) | P (review, design checkpoint) + G (the tests) |
| **QR-14b** | Each language MUST have ONE shared property prelude carrying its configuration, with a case budget per layer: node-layer properties use the default (200 runs), jsdom-layer ones stay modest, browser-layer ones stay in single digits up to about 20. A budget is changed only through the prelude's override, never inlined ad hoc, and only on a measurement. | Each file inventing its own budget; a browser property expensive enough to flake under load | `packages/model/src/test-utils/fast-check.ts` (`withDefaults()`, `numRuns: 200`), re-exported by the per-package wrappers and held by `tools/arch-lint/src/fast-check-prelude-check.test.ts` | One `ProptestConfig` helper in a shared test-utils crate (default cases equal to TypeScript's 200), `with_cases` overrides only through it; a scan refusing `ProptestConfig { .. }` built elsewhere | G |
| **QR-14c** | Generators MUST be derived from the schema of what they generate (the neutral schema, QR-6), shared arbitraries live in the owning package's test utilities, and a schema construct the deriver does not model MUST be a hard error, never a silently narrower generator. (Restates QR-9 for property code.) | Generators lagging a new schema field; a property that never draws the new case | `packages/model/src/test-utils/zod-arbitrary.ts` (`arbitraryForSchema`, throws on an unmodelled construct); `canvas-render/src/test-utils/facet-arbitraries.ts` | proptest strategies generated by the `xtask` from `contracts/` (or `proptest-derive` on the generated types), refusing any construct outside the dialect | G |
| **QR-14d** | A seed MUST NOT be pinned to force a property green: a flake under load is a resource signal (lower the budget), not an RNG problem. When a property finds a real bug, the shrunk counterexample MUST be committed as an example test BEFORE the production fix. | Real bugs hidden as "flakes"; a fix with no regression pinned | `test-layer-selection` skill (discipline); fast-check wrappers carry no seed | proptest's `failure_persistence` files under `proptest-regressions/` ARE the pinned examples and MUST be committed; a fixed `rng_seed` (or `PROPTEST_RNG_SEED` in CI) is banned by a scan | P + G (scan) |
| **QR-14e** | A property MUST NOT be vacuous: it carries a reachability floor — the generator's draws are classified and a measured minimum of the interesting class must be reached — and a sparse generator is answered with a denser domain, never with more runs. | A property that passes because its generator never reaches the arrangement it is about (boxes that rarely overlap, sequences that rarely collide) | `afterAllFloor(feeders, floor)` from `@kamiazya/whiteboard-model/test-utils`, held by `tools/arch-lint/src/after-all-floor-check.test.ts` | A shared classified-draw counter in the test-utils crate asserting its floor after the run (proptest has no built-in); `prop_assume!` rejection rates bounded, since a high rejection rate is the same vacuity | G |
| **QR-14f** | Every new property MUST be mutation-checked: plant the defect it exists to catch, see it fail, restore. A by-hand check MUST be shown to have substituted something. | A property that asserts nothing, which no other gate can tell from one that does | `.claude/scripts/mutate.mjs` (exits 3 when the substitution matched nothing); `diagnosis-evidence` skill | The same script (it is text substitution, language-neutral); in-diff cargo-mutants (QR-17) catches the rest mechanically | P + G (QR-17) |
| **QR-14g** | A state machine MUST be tested model-based: random command sequences against a model, with an injected clock, and invariants checked after every step. Ordering and race behaviour MUST be tested by an explored schedule, not by timing. | Ordering bugs a fixed script cannot order into existence; races that appear only under load | `fc.commands` model tests (`apps/web/src/components/markdown-editor/editor-verbs.model.property.test.ts`, `apps/web/src/lib/persistence-ledger.property.test.ts`); `*.race.test.ts` (`packages/mcp-server/src/shared/mkdir-lock.race.test.ts`) | `proptest-state-machine` for model tests; `loom` (exhaustive interleavings) or `shuttle` (randomised schedules) for the async ports and `WorkspaceLock` | G |
| **QR-14h** | During the migration, the TypeScript-against-Rust differential is a property layer in its own right: schema-derived inputs drive both implementations with exact equality, and the oracle shares nothing with its subject but the generated schema types. | A port that agrees with its oracle only on the examples someone wrote | The template is the frozen-oracle differential (`packages/mcp-server/src/cli/argv.differential.test.ts`) | QR-21 layer 2 | G |
| **QR-14i** | Properties and fuzzing are separate pillars, and neither substitutes for the other: a property states an invariant over a generator someone wrote; a fuzzer searches, coverage-guided, for inputs no generator was written to produce. A module with an untrusted-input entry MUST have both. | Treating a passing property as evidence that a parser survives hostile input | None — no TypeScript fuzzing exists | QR-29 (its own section); property counterexamples seed the fuzz corpora | G (via QR-29) |

## 6. Mutation testing

| QR | Requirement | Guards against | TypeScript today | Rust | Gate · where |
|---|---|---|---|---|---|
| **QR-17** | Rust: every mutant in a PR's diff MUST be caught, or ledgered with a reason. A full run on `main` MUST run nightly and be reported. A by-hand mutation check MUST be shown to have changed something. | Tests and properties that assert nothing; a "mutation check" that substituted nothing | Stryker lanes, report-only: `pnpm mutation:render` (`packages/canvas-render/stryker.config.mjs`, `stryker-targets.mjs`) and `pnpm mutation:contracts` (`packages/mcp-server/stryker.config.mjs`); `mutation.yml` (diff-scoped PR comment, weekly full); lane pinned exactly by `mutation-lane-coverage.test.ts` with its `KNOWN_EQUIVALENT` ledger; `.claude/scripts/mutate.mjs` (exits 3 when nothing matched) | cargo-mutants. PR: `cargo mutants --in-diff` against the PR base, after a separate green test step, with `--baseline=skip`, an explicit `--timeout`, `--test-workspace=true`, sharded `--shard k/n` with identical arguments and `fail-fast: false`. Ledger: `#[mutants::skip]` only with a reason on the same item, and `.cargo/mutants.toml` `exclude_re` entries each carrying a reason, with a test that every regex still matches a mutant in `cargo mutants --list` (a stale entry fails) and the count pinned. Nightly: the full workspace run on `main`, survivors filed as whiteboard issues | Rust: G (PR) + S (nightly). TypeScript: R |

**Exit codes are decisions, not noise.** cargo-mutants exits 0 when every
mutant was caught, 2 when one was missed, 3 when one timed out, 4 when the
baseline failed. The gate fails on 2; on 3 unless that mutant is ledgered as a
timeout with its measured duration; and on 4 as a failed run, never as a pass.
A tests-only diff produces no mutants and passes trivially.

**Survivors are classified before they are acted on**, with the classes
[testing.md](testing.md#survivor-classification) already uses: real risk (add
the test that kills it), equivalent (ledger it), intentionally permissive
(ledger it with the contract it follows). TypeScript's fourth class,
perTest-escaping, has no Rust counterpart because the gate runs the whole
workspace's tests per mutant (`--test-workspace=true`).

**Why Rust gates and TypeScript does not — the asymmetry is deliberate.** The
reasons TypeScript mutation is report-only are real, and the Rust gate is
shaped to answer each of them rather than to ignore them:

| TypeScript reason for report-only | Rust answer |
|---|---|
| A lane's score belongs to the whole suite, not to whoever pushed last | `--in-diff`: only mutants in the author's own diff are judged |
| Stryker's per-test coverage and related-test selection let the killing test escape, so a survivor needs hand verification before it means anything | Every mutant runs the whole workspace's test binaries; no selection to escape |
| Whole lanes take hours (`canvas-render`'s bare lane is about 3.5 h of mutants) and some tests are isolation-incompatible | A diff-scoped, sharded run is minutes; nextest isolates per process |
| The TypeScript in `packages/*` is frozen and is the oracle on its way out | Gating it would spend effort on code scheduled for deletion; the Rust code is new, written test-first, and stays |

## 7. Coverage

| QR | Requirement | Guards against | TypeScript today | Rust | Gate · where |
|---|---|---|---|---|---|
| **QR-18** | Rust: line and region coverage of native test runs MUST stay at or above a per-crate floor. The floor only goes up: the gate fails below it, and fails when the measurement exceeds it by more than the size ledgers' headroom, so the floor is raised in the PR that earned it. Branch coverage SHOULD be reported. Semantic coverage (QR-14e's floors, QR-15's ledgers) applies to both languages. | Code no test loads; a coverage floor left far below the real figure | `pnpm coverage` (`tools/checks/src/run-coverage.mjs`, v8 lcov over every non-browser project) feeding `sonarqube.yml`; no threshold anywhere; exclusions held by `sonar-coverage-declaration.test.ts` | `cargo llvm-cov nextest` with `--fail-under-lines` and `--fail-under-regions` per crate from a floor ledger read by the `xtask`; branch coverage on a pinned nightly, report-only (unstable in rustc; MC/DC was removed). No wasm coverage exists: native runs stand for both targets, and QR-21's cross-target layer is what proves they behave alike | Rust: G (line, region) + R (branch). TypeScript: R |

## 8. Quality scoreboards and measured change

| QR | Requirement | Guards against | TypeScript today | Rust | Gate · where |
|---|---|---|---|---|---|
| **QR-19** | A heuristic, cost model, search, layout or tool surface MUST be judged by a scoreboard: a corpus of every reported defect plus dense generated cases, with aggregate metrics pinned EXACTLY, from an oracle independent of the code it judges. A change's benefit MUST be classified (`delta`, `relocation`, `elimination`, `obvious`), and its instrument MUST land first, in its own commit. A behaviour-preserving port MUST leave every pinned number identical with no expectation edited. | Layout changes that move failures elsewhere; "obviously right" changes that regress; unmeasured optimisations | Seventeen scoreboards, among them `packages/canvas-render/src/layout/edges/edge-routing-quality.test.ts`, `text-wrapping-quality.test.ts`, `tidy-quality.test.ts`, `packages/server-core/src/search/search-quality.test.ts`, `packages/mcp-server/src/server/mcp/tool-surface-quality.test.ts`; oracles in `canvas-render/src/test-utils/` (`routing-metrics.ts`, `routing-corpus.ts`); `measured-change` skill; `pnpm eval:tool-surface` | The TypeScript scoreboards run unchanged against the Rust implementation through the shim (QR-21 layer 1); their oracles stay in TypeScript, or are rewritten independently — never ported from the subject | G (ordinary tests); P (benefit, instrument first) |

## 9. Determinism and goldens

| QR | Requirement | Guards against | TypeScript today | Rust | Gate · where |
|---|---|---|---|---|---|
| **QR-20** | Rendered and serialised output MUST be byte-identical across every runtime that produces it: TypeScript on Node and in the browser, Rust native, Rust wasm. Goldens are shared committed files asserted from every runtime. Core code MUST NOT use hash-ordered collections, unstable sorts, partial comparators, platform transcendentals or platform number formatting; every string length or offset MUST declare its unit (UTF-16 code units at a JavaScript-facing boundary). Goldens move once, at the det precursor, and afterwards only through a ledgered exception. | Cross-runtime nondeterminism of the renderer; a one-ulp difference flipping a tie-break; `toFixed` tie rules; UTF-8 vs UTF-16 ordering above U+E000; per-runtime text measurement | `packages/canvas-render/src/test-utils/golden-scene.ts` asserted by `svg/determinism.test.ts` and `svg/determinism.browser.test.ts`; pixel goldens `svg/pixel-golden.browser.test.ts`; `sceneDigest`; `measure-text-conformance.ts` run by `mcp-server/src/server/export/measure-text.conformance.test.ts` and `canvas-viewer/src/measure-text.conformance.browser.test.tsx`; `code-unit-order.test.ts`, `locale-compare-ban.test.ts`, `inline-comparator-ban.test.ts` | `crates/core/clippy.toml`: `disallowed-types` `HashMap`/`HashSet`, `disallowed-methods` `sort_unstable*`, `partial_cmp` unwrapping and std's `f64` transcendentals; `libm` for math; `det` for `format_coord` (ECMAScript `toFixed`), ryu-js for `Number#toString`, RFC 8785 for canonical JSON, UTF-16 comparison and lengths; insta snapshots with `INSTA_UPDATE=no` in CI; the same golden files asserted natively and under `wasm-bindgen-test`; the Rust measurer joins the measure-text conformance suite | G |

## 10. Cross-runtime parity and the differential harness

| QR | Requirement | Guards against | TypeScript today | Rust | Gate · where |
|---|---|---|---|---|---|
| **QR-21** | A ported function MUST be held to its TypeScript oracle by three layers: (1) the existing TypeScript suites and scoreboards re-run against the Rust implementation; (2) a property differential with EXACT equality on output; (3) the same fixtures run natively and on wasm, byte-equal. The oracle MUST share nothing with its subject but the schema-generated types. The harness MUST be mutation-checked by planting a one-ulp change on the Rust side and seeing it fail. Any tolerance MUST be a both-sided ledger entry for one named case, never a global epsilon. A mismatch MUST be reported with a minimal repro. | A differential blind to whatever it shares with its subject (22 survivors under `edge-crossing-sweep`'s full-scan oracle that called the same scoring helper); an epsilon hiding a changed discrete choice | Templates: `packages/mcp-server/src/cli/argv.differential.test.ts` (frozen old implementation as oracle); `libsql-document-store.parity.test.ts`; `apps/web/src/lib/layout-worker-parity.browser.test.tsx`; `server-mode-route-parity.test.ts`; `apps/web/src/lib/keeper-parity.test.ts` (declared differences, nothing undecided) | A vitest project per ported package running the existing suites through `@kamiazya/whiteboard-core-wasm` (first: `canvas-render-rust`); fast-check generators from QR-9 driving TypeScript and wasm with exact comparison; `wasm-bindgen-test` on Node over the native fixture set; the `CoreImpl` switch's `differential` mode in CI and dogfooding; the `PORTED_FUNCTIONS` ledger (QR-33) | G |

## 11. Performance and benchmarks

| QR | Requirement | Guards against | TypeScript today | Rust | Gate · where |
|---|---|---|---|---|---|
| **QR-22** | A performance claim MUST come from interleaved paired rounds with variance, never from one run. Every port MUST measure its boundary cost — marshalling plus call, against the TypeScript it replaces — before it is switched to `rust`; a chatty boundary can erase the win. Benchmarks are report-only; loop-availability ceilings remain gates. | Machine drift taken for an effect; a wasm port slower than the TypeScript it replaced because of its boundary; background work stalling the serving loop | `pnpm bench` (`spatial-edges.bench.ts`, `spatial-canvas.bench.ts`, `mdast-blocks.bench.ts`, `snippet.bench.ts`; `bench-invocation.test.ts`); `measured-change` skill; `packages/mcp-server/src/shared/test-utils/loop-availability.ts` with `background-work-costs.ts` | criterion or divan locally; instruction counts (gungraun) in CI as a report; a boundary benchmark per port (the measure-text corpus for measurement, live-drag relayout for the typed-array fast path); Workers CPU per layout size measured on the runtime; stall ceilings from tokio runtime metrics | R (benchmarks); G (stall ceilings) |

## 12. Size and complexity budgets

| QR | Requirement | Guards against | TypeScript today | Rust | Gate · where |
|---|---|---|---|---|---|
| **QR-23** | Files MUST stay under 800 lines and functions under 50, cognitive complexity under 15, with grandfathered exceptions as shrink-only ceilings with headroom. Every shipped wasm artifact MUST have a byte budget in a shrink-only ledger with headroom, and MUST fit the Workers limits (64 MiB uncompressed, 1 s startup, 128 MB per isolate including wasm). Budgets are measured on the merge ref. | File and function bloat; hard-to-follow code; a wasm artifact that grows until a Worker refuses it | `file-size-budget.test.ts`, `function-size-budget.test.ts`, `size-ledger-headroom.ts`; Biome `noExcessiveCognitiveComplexity` with `complexity-exemptions.test.ts`; web bundle-size budgets (`apps/web/scripts/`) | The file-size scan extended to `crates/**/*.rs`; `clippy.toml` `too-many-lines-threshold = 50` and `cognitive-complexity-threshold = 15` with each `#[allow]` counted in a pinned ledger; `cargo xtask size-ledger` over the `render`, `full` and `worker` artifacts (release profile: `lto`, `codegen-units = 1`, `panic = "abort"`, `strip`; `wasm-opt -Oz`; twiggy to inspect); wasm added to the web bundle-size budget | PP + G |

## 13. Flake discipline

| QR | Requirement | Guards against | TypeScript today | Rust | Gate · where |
|---|---|---|---|---|---|
| **QR-24** | Every test a PR touches MUST be stress-run before merge. Retries MUST NOT be a fix (repeats expose, retries hide). A parked test MUST be bounded: at most 8 parked, at most 14 days each, each marked with date, issue and reason. A test failing on two distinct `main` runs in 14 days MUST become a root-cause lane. Tests wait for conditions, never for time. | New flaky tests entering `main`; skip graveyards; re-running instead of root-causing | `stress-changed-tests` job and `node .claude/scripts/stress-changed.mjs` (5 fresh runs plus a `--repeats=3` pass); `.claude/scripts/quarantine.test.mjs`; `node .claude/scripts/flake-watch.mjs`; `test-fixed-sleep-ledger.test.ts`; `steward`'s `reference/flake-shapes.md` | The stress job extended to changed Rust test binaries (repeated nextest runs in fresh processes); the nextest CI profile sets `retries = 0`; `#[ignore = "QUARANTINE(<date> <issue>): <why>"]` counted by the same quarantine scan; nextest JUnit output carrying the identifiers flake-watch reads; the sleep ledger extended to `thread::sleep`/`tokio::time::sleep` in tests, `tokio::time::pause` preferred | G (stress, quarantine budget); S/advisory (flake-watch) |

## 14. Logging and redaction

| QR | Requirement | Guards against | TypeScript today | Rust | Gate · where |
|---|---|---|---|---|---|
| **QR-25** | Server code MUST NOT write to stdout or stderr directly; it logs through the project logger with the eight RFC 5424 levels, fields first, one JSON line per record on stderr, gated by `WHITEBOARD_LOG_LEVEL`. Secret-bearing fields MUST be redacted from one shared list. Tests assert on captured records, not on a console spy. | Corrupting stdio JSON-RPC on stdout; the printf overload dropping the data argument; secrets in logs | `packages/mcp-server/src/server/log.ts` (pino, redaction list); Biome `noConsole` scoped to `mcp-server/src/server/**`; `tools/biome-plugins/logger-argument-order.grit`; `redaction-one-place.test.ts`; `captureLogsForTests` | The `log` core crate: an RFC 5424 `Level`, a fields-first macro (so the dropped-argument shape cannot be written), the daemon sink emitting pino's JSON line shape; the redaction list moved to one data file read by both pino and the Rust sink; `clippy.toml` `disallowed-macros` for `println!`, `eprintln!`, `dbg!` plus `print_stdout`/`print_stderr` denied; third-party `tracing`/`log` bridged in bindings only | PP + G |

## 15. Errors and panics

| QR | Requirement | Guards against | TypeScript today | Rust | Gate · where |
|---|---|---|---|---|---|
| **QR-26** | A refusal MUST be a typed value with a code from one generated table, mapped to HTTP status and MCP error in the adapters only, and every error class MUST map to a refusal. Only "not found" may read as absence. Core code MUST NOT panic: no `unwrap`, `expect`, `panic!`, and in layout crates no unchecked indexing ("layout is total"). A wasm panic MUST be treated as poisoning its instance: the shim reports `DocumentEngineTrapError` (500) and re-instantiates, and the layout worker pool does the same. | Non-JSON refusals; `err.message` in the code slot; an error class unmapped to a refusal; a swallowed read failure; an aborted wasm instance answering the next call with corrupt state | `tools/biome-plugins/route-refusal-shapes.grit`; `v1-refusals-cover-errors.test.ts`; `read-failure-as-absence.test.ts`; `DocumentEngineTrapError` in `server-core` (`document-io.engine-trap.test.ts`) | `RefusalCode` generated from `contracts/refusals.json`, with an exhaustive `match` replacing the coverage test; `thiserror` enums implementing `Refusal`; `{ok:false, refusal}` across the ABI; clippy `unwrap_used`, `expect_used`, `panic` denied in core (`allow-unwrap-in-tests`, `allow-expect-in-tests` in `clippy.toml`), `indexing_slicing` denied in `edge-routing` and `canvas-render`; only `io::ErrorKind::NotFound` means absent; wasm `panic = "abort"` with a hook; a shim test that a trap re-instantiates and the next call succeeds | G |

## 16. Supply chain

| QR | Requirement | Guards against | TypeScript today | Rust | Gate · where |
|---|---|---|---|---|---|
| **QR-27a** | Known-vulnerable runtime dependencies MUST fail the merge, and the same check MUST run on a schedule against an unchanged tree. Licences, sources and duplicate versions MUST be policy-checked. The lockfile MUST be committed and honoured (`--locked`/`--frozen-lockfile`). Fresh releases SHOULD wait out a minimum age. Shipped binaries MUST carry an SBOM. Workflow actions MUST be pinned by SHA. | Vulnerable or malicious dependencies; an advisory database moving while the tree stands still; artifact tampering | `pnpm audit:prod` (`tools/checks/src/audit-with-retry.mjs`); `audit.yml` held identical by `scheduled-audit.test.ts`; `minimumReleaseAge` in `pnpm-workspace.yaml`; CycloneDX SBOM job and `sbom-policy.test.ts`; `ci-policy.test.ts`, `workflow-hygiene.test.ts`; `secretlint` (PC); CodeQL | `cargo deny check` (`deny.toml`: advisories, bans with multiple-versions, licences, sources) as the gate, its advisories step repeated on a schedule and held identical by a test; `Cargo.lock` committed, `--locked` on every cargo command; Dependabot `cargo` ecosystem; cargo-vet for the published binary's dependencies (SHOULD), and a publish-age check over crates.io (SHOULD); `cargo auditable` plus `cargo-cyclonedx` for binaries; `dtolnay/rust-toolchain` and every other action pinned by SHA; CodeQL Rust analysis | G (deny, lockfile); S (scheduled advisories); Rel (SBOM) |
| **QR-27b** | Every released artifact MUST carry build provenance and published checksums from the first release: SLSA provenance for the native binaries and the wasm artifacts, `npm publish --provenance` for every npm package (the launcher and each per-OS package), and a checksum file attached to the GitHub release that the launcher's packages and the plain binaries are verified against. OS code signing — macOS signing with notarization, Windows Authenticode — MUST be scaffolded in the release workflow now and enabled once the owner provides certificates; until then the release notes say the binaries are unsigned. | Artifact tampering between build and install; a user unable to tell a released binary from a substituted one | npm provenance over OIDC, Docker SBOM and provenance attestations, cosign keyless signing (`release.yml`); `release-tag-shape.test.ts`, `release-gates.test.ts` | GitHub artifact attestations (SLSA build provenance) per binary and wasm artifact; `--provenance` on every `npm publish`; `SHA256SUMS` on the release; cosign keyless signatures; signing and notarization steps present but gated on the certificate secrets existing, with a test that the steps exist and that their absence is reported rather than silent | Rel |

## 17. Rust hardening

Each item here is a GATE (owner decision, ADR-0054 decision 16) — merge
gates unless marked as release gates. They have no TypeScript counterpart
because the defect classes are native-code ones, or because the JavaScript
runtime already absorbs them (a JavaScript integer does not wrap; a
JavaScript array read past its end answers `undefined`).

| QR | Requirement | Guards against | TypeScript today | Rust | Gate · where |
|---|---|---|---|---|---|
| **QR-28a** | Production code MUST NOT panic or wrap silently: no `unwrap`, `expect` or `panic!`; `indexing_slicing` and `arithmetic_side_effects` restricted (denied in core, allowed per site only with a reason in a pinned ledger); overflow checks ON in release builds. | A panic as a denial of service; silent integer wrap-around turning into a wrong size, offset or allocation | Not applicable (see above); QR-26 covers the refusal model | `[workspace.lints.clippy]` `unwrap_used`, `expect_used`, `panic`, `indexing_slicing`, `arithmetic_side_effects` denied (test code exempt through `clippy.toml`); `[profile.release] overflow-checks = true`; each `#[allow]` of these counted in a pinned ledger | G |
| **QR-28b** | Every untrusted-input entry MUST declare its caps — input size, recursion or nesting depth, and work or time — and enforce them before parsing, refusing with a generated refusal code. A guard MUST fail when an entry has no declared caps, and a test per entry MUST show each cap refusing just above its value. | Memory exhaustion from one oversized body; stack overflow from deep nesting; a parse that runs for minutes (algorithmic-complexity attacks) | Partial and per site: body-size limits on daemon routes, `utf16Max` length limits in the schemas | An entry registry (the same list the fuzz targets are derived from, QR-29a) with `max_bytes`, `max_depth`, `max_work` per entry; serde_json's recursion limit kept on; a guard test over the registry; refusal codes from `contracts/refusals.json` | G |
| **QR-28c** | Dependencies are part of the attack surface: cargo-deny MUST pass (QR-27a), and the amount of `unsafe` the dependency tree carries MUST be recorded per crate in a shrink-only ledger — a dependency change that raises it fails until the ledger is raised deliberately, with a reason. | Unsafe code arriving through a dependency bump nobody read | `allowBuilds` install-script allowlist; `minimumReleaseAge` (`pnpm-workspace.yaml`) | `cargo deny check`; cargo-geiger counts per dependency compared against a committed ledger, guarded from both sides (a ledger entry for a crate no longer in the tree fails) | G |
| **QR-28d** | A release binary MUST pass a hardening check before it is published: position-independent executable, full RELRO, stack protector, NX, and stripped of symbols. | A release binary built without the platform's exploit mitigations | Not applicable | A check over each release binary (checksec-style, ELF/Mach-O/PE as appropriate) in the release workflow; release profile `strip = true`, PIE and RELRO flags in `.cargo/config.toml` | Rel |
| **QR-28e** | A release build MUST be reproducible: built twice from the same commit in clean environments, the artifacts (binaries, wasm, npm tarballs) MUST be byte-equal. | A build that embeds paths, timestamps or nondeterministic codegen, so no one can verify a binary against its source | Not applicable (no compiled artifacts) | Two release builds in separate jobs with `--remap-path-prefix`, `SOURCE_DATE_EPOCH` and the pinned toolchain; a byte comparison of every artifact; the same check for the wasm after `wasm-bindgen` and `wasm-opt` | Rel |
| **QR-28f** | Fuzz targets MUST also run under AddressSanitizer and UndefinedBehaviorSanitizer on a pinned nightly toolchain. | Memory errors in the few places `unsafe` exists (bindings, dependencies) that a safe-code crash would not reveal | Not applicable | cargo-fuzz with `-Zsanitizer=address` and the UB checks on the pinned nightly named beside `rust-toolchain.toml`; runs with the nightly fuzz job (QR-29d) | S (findings filed; a crash is pinned per QR-29c) |
| **QR-28g** | `unsafe` MUST be forbidden workspace-wide. An exemption is allowed only in a binding crate, per block, with a `SAFETY:` comment, and a crate holding one MUST run under Miri. | Undefined behaviour in this repository's own code | Not applicable | `[workspace.lints.rust] unsafe_code = "forbid"`; a binding overrides to `deny` and allows per site; clippy `undocumented_unsafe_blocks` denied; a Miri job over every crate with an exemption | G |

## 18. Fuzzing

Fuzzing is its own pillar (ADR-0054 decision 15), not a complement to the
property tests: it searches for inputs no generator was written to produce,
and it is the main evidence that an entry exposed to untrusted input does not
crash, hang or exhaust memory. TypeScript has none today; this section is new
ground for both languages' entries once they are in Rust.

| QR | Requirement | Guards against | TypeScript today | Rust | Gate · where |
|---|---|---|---|---|---|
| **QR-29a** | Every untrusted-input entry MUST have a fuzz target: the OKF, JSON Canvas and OCIF parsers; sync-frame decoders; the HTTP request bodies and MCP JSON-RPC messages; loro snapshot and update import; JSON crossing the wasm boundary; font files read by the measurer. The list of entries is a registry, and a guard MUST fail when an entry has no target or a target names no entry. | An input surface nobody fuzzes because nobody listed it | None — a gap this closes | cargo-fuzz (libFuzzer) targets under `fuzz/`, one per registry entry (the registry QR-28b caps); structured targets with `arbitrary` where the input has a grammar, bolero where a target doubles as a property | G (the registry guard) |
| **QR-29b** | Corpora MUST be seeded from what the repository already knows: the TypeScript fixtures, the scoreboard corpora, and every property counterexample. The corpus is kept, minimised and grown by the nightly run. | Starting a fuzzer from nothing and spending its budget rediscovering the format | The fixtures and corpora exist (`routing-corpus.ts`, the codec fixtures, `proptest-regressions/` once present) | A seeding step in the `xtask`; `cargo fuzz cmin` on the stored corpus; the corpus stored as a CI cache/artifact rather than in git, except the regression inputs (QR-29c) | S |
| **QR-29c** | Every crash, hang or out-of-memory a fuzzer finds MUST become a committed regression test — the minimised input as a fixture and a unit test over it — before the fix lands. | A fixed crash that comes back; a finding that lives only in a CI artifact | Not applicable | `cargo fuzz tmin` to minimise; the input committed beside the target's regression test; the fix PR carries both | P + G (the test) |
| **QR-29d** | On a PR, the fuzz targets whose entry the diff can reach MUST run for tens of seconds each, and a crash MUST block the merge. Nightly on `main`, every target runs long, the corpus grows, and the result is reported. | A change that crashes on hostile input reaching `main`; a corpus that never grows | Not applicable | PR: targets selected through the affected set (QR-32), a fixed time budget per target, a crash failing the job into `ci-gate`. Nightly: all targets with sanitizers (QR-28f), corpus merged back, findings filed as whiteboard issues | G (PR) + S (nightly) |
| **QR-29e** | Fuzz coverage MUST be tracked per target, so a target that has stopped reaching new code is visible. | A fuzzer running for hours inside the first branch of its parser | Not applicable | `cargo fuzz coverage` (llvm-cov) per target in the nightly run, published as a report with the trend | R |

## 19. Docs, review and process

| QR | Requirement | Guards against | TypeScript today | Rust | Gate · where |
|---|---|---|---|---|---|
| **QR-30** | A user-visible, API, contract or configuration change MUST ship its docs in the same increment, describing the shipped state, in English. Comments carry enduring rationale only — no PR, issue or chronology references. A decision that is cross-cutting or expensive to reverse MUST be an ADR. | Docs drifting from behaviour; comments pointing at things that are gone; relitigated decisions | `docs-sync` skill; `tools/arch-lint/src/docs-*.test.ts`; the comment-hygiene scans of QR-4; [adr/](adr/) | Same, with the comment scans extended to `*.rs` and rustdoc's `broken_intra_doc_links` denied; crate-level docs (`//!`) on every crate stating its layer and what it absorbs | PP + G; P |
| **QR-31** | Every change MUST pass the design checkpoints (`scope`, `blastRadius`, `userReach`, `benefit`) and the review lanes (dimensions, adversarial verify, QA); real behaviour MUST be verified by hand; a regression fix MUST be mutation-checked (revert the fix, see the test fail, restore). PR titles MUST be Conventional Commits. A user-visible change ships before/after evidence or says why not. | Built-but-unwired code; self-review blind spots; a regression test that does not catch its bug; wrong release bumps | `.claude/workflows/review.workflow.mjs`, `.claude/skills/review-gate/`; `.claude/scripts/check-design.mjs`; `diagnosis-evidence` skill; `pr-title.yml`; `.claude/scripts/hooks/pre-pr-visual-evidence.mjs` | Unchanged: the process is language-neutral. Rust crates join release-please's linked versions so the shim and the wasm release together | P + G (PR title) |

## 20. CI scope-aware selection

| QR | Requirement | Guards against | TypeScript today | Rust | Gate · where |
|---|---|---|---|---|---|
| **QR-32** | CI MUST select jobs and steps from the affected set computed over the workspace graph, and MUST fail closed: an unclassified file or an unreadable graph selects everything. `main` MUST always run everything. A job skipped by scope MUST be a declared skip that `ci-gate` accepts, never a missing result. Every job MUST be in `ci-gate`'s `needs`, and the local full pass MUST stay derived from CI. | Every PR paying for both languages during coexistence; a scope rule silently skipping a job the change could break; a gate that cannot tell skipped from absent | `ci-gate.mjs` reading per-leg conclusions with `SKIPPABLE_JOBS`; `ci-gate.test.ts` (every `ci.yml` job in `needs`); `docker-build-inputs.mjs` skipping untouched inputs; `local-gate-command.test.ts` deriving `pnpm check:local` from `ci.yml`; scope-aware selection itself is in construction (ADR-0054 decision 10) | The affected set extended to cargo crates through `cargo metadata`; the Rust job (fmt, clippy, nextest, wasm32 build with import scan, cargo-deny, codegen check, arch-map, size ledger, `wasm-bindgen-test`, the differential projects, llvm-cov, mutants in-diff, changed-entry fuzz targets) feeding `ci-gate`; the release workflow adds the hardening, reproducibility and provenance gates (QR-27b, QR-28d, QR-28e); a shared `CARGO_TARGET_DIR` per machine for worktrees | G |

## 21. Parity checklist for porting a module

**QR-33.** A function's `CoreImpl` switch MUST NOT move from `differential` to
`rust` until every box below is ticked, in the PR that moves it. The PR body
carries the list.

| # | Check | Requirement |
|---|---|---|
| 1 | Its input and output contracts are in `contracts/`, in the dialect, generated into both languages, and `codegen --check` is clean | QR-6, QR-7 |
| 2 | The crate sits in the layer the architecture map declares, its dependencies equal the allowed set, and its core wasm imports nothing | QR-10, QR-11 |
| 3 | Clippy, fmt and the core lint set (no hash maps, no unstable sort, no platform float, no `unwrap`/`expect`/`panic`, indexing and arithmetic restricted) pass with no new `#[allow]` outside a ledger | QR-1, QR-20, QR-26, QR-28a |
| 4 | Native unit tests exist, written red-first; every property class QR-14a requires is present, through the shared prelude, with schema-derived generators, a reachability floor, committed regressions, no pinned seed, and each new property mutation-checked | QR-13, QR-14a–QR-14g |
| 5 | Every port implementation the module touches runs its conformance suite | QR-15 |
| 6 | Layer 1: every existing TypeScript test and scoreboard for the function passes against the Rust implementation, with every pinned number identical and no expectation edited | QR-19, QR-21 |
| 7 | Layer 2: the property differential runs with exact equality, and was shown to fail on a planted one-ulp change | QR-21 |
| 8 | Layer 3: the shared fixtures and goldens are byte-identical natively and on wasm | QR-20, QR-21 |
| 9 | Every tolerated difference is a both-sided ledger entry naming one case and its reason | QR-21 |
| 10 | `differential` mode has run in CI and in dogfooding with no unexplained mismatch | QR-21 |
| 11 | `cargo mutants --in-diff` is clean or ledgered; line and region coverage are at or above the crate's floor | QR-17, QR-18 |
| 12 | The boundary cost was measured against the TypeScript it replaces, and the result is in the PR body | QR-22 |
| 13 | The wasm artifact's size is within its ledger | QR-23 |
| 14 | Every untrusted-input entry it exposes has declared caps and a fuzz target, seeded and run, with no open crash | QR-28b, QR-29a–QR-29d |
| 15 | Logging goes through the `log` facade; refusals use generated codes; a trap re-instantiates | QR-25, QR-26 |
| 16 | The `PORTED_FUNCTIONS` ledger lists the function, and once the switch is `rust` the TypeScript export is a re-export of the shim | ADR-0054 |
| 17 | Docs reflect the shipped state | QR-30 |

When the last function of a TypeScript package reaches `rust`, the package is
deleted, its tests are kept and pointed at the shim, and only then are they
moved to Rust.
