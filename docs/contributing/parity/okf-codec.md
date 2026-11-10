# Parity checklist: the OKF envelope

The [QR-33a](../quality-requirements.md) checklist for the second ported
module: `parseOkf` and `serializeOkf` in `packages/codec/src/okf` (Rust:
`crates/core/codec`, two wasm exports `okf_parse` and `okf_serialize`, ABI 15,
reached through `@kamiazya/whiteboard-core-wasm`). It is filled in as the
module stands, so a row says what is shown, not what is intended.

The switch is `okfCodec` (`packages/codec/src/okf/okf-core.ts`), set by
`WHITEBOARD_CORE_OKF` in the daemon and `VITE_WHITEBOARD_CORE_OKF` in the web
app. It is `rust` by default now, as edge routing's is: a daemon with nothing
set and a production build of the web app answer in Rust. It stays
`differential` under development and CI, and `ts` in a test run of the web
app. It **may not move to `rust` until every row below is `met` or `n/a`**, and
in the PR that moved it every row is.

Ports, in order:
- #2196: the spikes. A markdown stringify port was deferred; the frontmatter reader was found possible.
- #2197: the TypeScript frontmatter held to a restricted YAML subset.
- #2198: `yaml` pinned.
- #2199: the frontmatter reader and writer, held to `frontmatter.jsonl`.
- #2203: the OKF envelope, held to `okf.jsonl`.
- #2204: the wasm exports and the live differential.
- #2205: the switch, and the daemon on it.
- #2206: the web app on it.
- The default: both switches read `rust` when nothing is set.

## QR-33a

| # | Check | Status | Evidence, or what is missing |
|---|---|---|---|
| 1 | Contracts in `contracts/`, generated into both languages, `codegen --check` clean | met (accepted deviation: the value wire and the result tuples) | The frontmatter's shape is generated from `contracts/model/okf.schema.json` into both languages: Zod in `packages/model`, and Rust in `whiteboard-model` (`okf::OkfMarkdownFrontmatter`, `okf::OkfTrustEvent`), which `whiteboard-codec` and the wasm bindings use directly. The codec's checks the schema cannot state (actor, timestamp, extension-facet keys, `facetsRaw` keys) are `whiteboard_model::checks`, written once beside their TypeScript twins. The differential holds the two languages equal value by value (row 7), and `cargo xtask codegen --check` is clean. What is not generated: the tagged value wire (`crates/bindings/wasm/src/okf_wire.rs` and `packages/core-wasm/src/okf.ts`) and the positional ok/err result tuples. They are declared deviations, like routing's flat arrays (ADR-0054 decision 9). The wire's key order is held to the contract's `x-wb-order` by a native test in `okf_wire.rs`. |
| 2 | Layer per the architecture map; dependencies equal the allowed set; core wasm imports nothing | met | `crates/architecture-map.json` declares `whiteboard-codec` in the core layer, absorbing `packages/codec`. Its manifest depends on `whiteboard-det` alone (dev: `serde_json`, the proptest prelude). The bindings crate carries `serde_json` for the wire, allowed per crate in the map. `cargo xtask arch-map` and the wasm32 import scan run in the `rust` job through `pnpm rust:check`. |
| 3 | Clippy, fmt and the core lint set pass with no new `#[expect]` outside a ledger | met | `pnpm rust:check` passes on main. Every `#[expect]` is counted per crate per lint in `crates/expect-ledger.json`, held from both sides by `expect-ledger.test.ts`. |
| 4 | Native unit tests red-first; every QR-14a property class present through the shared prelude, with reachability floors, committed regressions, no pinned seed, each mutation-checked | met | A parser and serializer are QR-14a's first class. Through `whiteboard-proptest`:<br>• `tests/frontmatter_properties.rs` (12 tests, 4 properties): the reader is total, the writer's text reads back to what it wrote, and refusals land on their stage.<br>• `tests/okf_properties.rs` (23 tests, 4 properties): the fence split, the envelope round trip, and every damaged or schema-breaking frontmatter refused at its stage.<br>Each property has a reachability floor. The schema-stage floor was found vacuous (3 of 200) and fixed with a denser generator (`schema_breaks`, 25 or more over 5 runs), not more runs (#2204). Regressions the fuzzers found are committed under `crates/fuzz/regressions` and replayed by `rust:check`. The seed is never pinned (`rust-proptest-prelude.test.ts`). Examples: `frontmatter_examples.rs` (36), `okf_examples.rs` (33). |
| 5 | Every port implementation the module touches runs its conformance suite | n/a | The envelope touches no store or sync port; it is a pure function of a text or a document. |
| 6 | Layer 1: every TypeScript test passes against Rust, pinned numbers identical, no expectation edited | met | The `codec-rust` project (`packages/codec/vitest.rust.config.ts`) re-runs codec's OKF suites under `src/okf/` unchanged. Its resolver sends their `./parse.js` and `./serialize.js` to `src/test-utils/okf-wasm/`: the staged core under `okfCodec` at `rust`, so a declined call takes the production fallback.<br>Three files are excluded with reasons: `okf-core.test.ts` tests the switch itself, `parse.cost.test.ts` counts the TypeScript reader's work, and `yaml-safe.test.ts` never calls the envelope. `setup.ts` fails a file the core answered nothing for; bypassing a shim fails it.<br>Four tests are left out by title (`okf-wasm/tolerated.ts`). Each one's only assertion reads the words of a `yaml`-stage refusal, the tolerated difference of row 9. `tolerated.rust.test.ts` fails on a title no test carries any more, or on a listed test that no longer reads a message.<br>The first run found two defects, both fixed in the same PR:<br>• The Rust reader refused a long explicit key whose text starts with `?` or `-` followed by a non-blank, which both writers emit. The live differential's generators had never drawn such a key.<br>• Both writers lost a newline from a last value ending in a blank line (`t-okf-trailing-newline`, case 1). Fixed in both languages at the envelope, and the Rust property no longer filters that case out.<br>148 pass and 4 are skipped by title; three runs in a row were clean. |
| 7 | Layer 2: property differential with exact equality, shown to fail on a planted change | met | `packages/codec/src/okf/wasm.rust.test.ts` (project `codec-rust`, in CI's `rust` job) compares `Core.parseOkf` and `Core.serializeOkf` with the TypeScript, over two inputs:<br>• the 1700 recorded cases of `okf.jsonl` (1200 reads, 500 writes);<br>• generated texts and documents (1500 + 1500 + 600 draws).<br>What is held exactly:<br>• the document, every number by its 64 bits and every mapping in enumeration order;<br>• prototypes and own keys;<br>• the body verbatim;<br>• a refusal's stage and each issue's path and code.<br>A floor per outcome asserts each one was reached. Four planted one-character changes on the Rust side were each caught (#2204). |
| 8 | Layer 3: shared fixtures and goldens byte-identical natively and on wasm | met | `cargo xtask cross-target` runs `whiteboard-codec`'s tests natively and on wasm32 under Node with the same count. `tests/recorded_oracle.rs` and `tests/okf_oracle.rs` replay the recorded TypeScript answers in both. |
| 9 | Every tolerated difference is a both-sided ledger entry | met | `OKF_TOLERATED_DIFFERENCES` (`packages/codec/src/okf/okf-core.ts`) holds one entry, `yaml-refusal-message`, with its reason (owner decision q25). The TypeScript carries the `yaml` package's message, with line and column; the Rust reader names the class of fault. The switch's comparison and the live differential both read it through `messageTolerated` rather than restating the case. The other side: `wasm.rust.test.ts` counts YAML refusals whose two messages really differ and fails under 300 (the ledger is pinned to its one key there), so an entry whose case stopped differing fails rather than outliving it. Mutation-checked: tolerating nothing fails both the switch's tests and the differential. |
| 10 | `differential` has run in CI and in dogfooding with no unexplained mismatch | met (CI evidence) | The daemon runs OKF in `differential` in CI's `mcp-node` shards and the packaged smoke, with `WHITEBOARD_CORE_MISMATCH=throw` (#2205); 24 daemon tests were shown to reach the comparison by inverting it. The web app's browser jobs and browser stress leg run it with `VITE_WHITEBOARD_CORE_MISMATCH=throw` (#2206). There, a browser test drops a markdown note on the document list through the core, and inverting the comparison fails it. No run has reported a mismatch. As for routing (q18), the evidence is CI's runs, since only development data exists. |
| 11 | `cargo mutants --in-diff` clean or ledgered; coverage at or above the crate's floor | met | `rust-mutants` ran `--in-diff` on every port PR (#2199, #2203, #2204). Survivors that are equivalent or hang are ledgered with reasons in `.cargo/mutants.toml` (the codec cursor's `eof`, `bump`, `skip` and `blank_at`). Coverage floors in `crates/coverage-floor.json`:<br>• `core/codec`: 98 lines / 97 regions, measured 98.67% / 97.99%;<br>• `bindings/wasm`: 82 / 77, measured 82.97% / 77.43%. |
| 12 | One call per user operation; boundary cost measured on browser, Node and workerd against the TypeScript, result in the PR body | met | One call per operation holds: a read is one `okf_parse` and a write one `okf_serialize`, and `scripts/okf-boundary.mjs` fails if the Rust batches make any other number of wasm calls or the TypeScript batches make any. A body leaves through the shim, never through the wasm: Rust answers a UTF-16 offset and the shim slices the text, and a write sends only the frontmatter and appends the body. A read does carry the whole text IN, which is the one class where Rust is slower: 0.31 to 0.37 ms for a 191 KiB body against the TypeScript's 0.05 to 0.06 ms, 5.4x to 6.6x, on every runtime. Every other class is faster in Rust: reads 0.15x to 0.54x of the TypeScript, writes 0.51x to 0.79x. Measured on all three runtimes, [below](#boundary-cost-qr-22b). |
| 13 | Artifact size within its ledger, peak memory reported, Workers budgets measured | met for the measurement | Size: the OKF exports are inside the ledger's ceiling (`crates/wasm-size-ledger.json`, 901000 bytes against 900888 measured for the cargo artifact since the codec reads whiteboard-model's generated types; 899000 against 895418 before). The shipped module grew from 278770 to 520132 bytes (about 200 KB gzip), accepted as q27. Memory, measured 2026-11-09 by `scripts/okf-boundary.mjs`: linear memory is 1.13 MiB after init, 1.50 MiB after the 191 KiB body and peaks at 3.38 MiB on the 12k-tag frontmatter, the same on Node 24, Chromium 153 and workerd; every class is read and written dozens to hundreds of times before its figure is taken, so repeated calls reuse what the first grew. Startup (`coreFrom`, module compiled) is 1.7 ms on Node, 2.2 ms on Chromium and 1.0 ms on workerd. Elapsed time on a local workerd (`performance.now()`), set against the free plan's 10 ms of CPU per request, Rust: one note is 0.011 ms to read and 0.009 ms to write; the 12k-tag frontmatter is 7.5 ms to read and 10.3 ms to write, so a write of a frontmatter that large is over the limit and the read under it (the TypeScript is 32.5 and 13.5 ms, over it both ways). These are wall-clock timings on the engine, from a local binary whose clock advances during synchronous work, as the edge-routing checklist's row 13 says, not the platform's CPU accounting: the Workers budget itself stays unverified until QR-22c's workerd job measures it in CI, which is not done here. |
| 14 | Every untrusted-input entry has caps and a fuzz target, seeded and run, no open crash | met | `crates/input-caps.json` declares four entries, each with `maxBytes`, `maxDepth`, `maxMillis` and the measurement behind it:<br>• `whiteboard-codec::frontmatter::parse`<br>• `whiteboard-codec::okf::parse`<br>• `whiteboard-wasm::okf::okf_parse`<br>• `whiteboard-wasm::okf::okf_serialize`<br>Each names its fuzz target (`frontmatter_parse`, `okf_parse`, `okf_wasm_parse`, `okf_wasm_serialize`). `cargo xtask inputs` holds the registry and `crates/fuzz` equal. `rust-fuzz-pr` runs them on every PR and the nightly workflow longer. The caps are generated into both languages. The shim refuses past `maxBytes`, and on a lone surrogate, before the call, and `okfCodec` answers that refusal from the TypeScript. |
| 15 | Logging through the `log` facade; `thiserror` convention; poison-and-recover covers held state | n/a | The crate does not log. It answers refusals as values (`Failure`, `Refusal`, `Unwritable`), never as an error type a caller propagates; the shim words them. It holds no state across calls. |
| 16 | `PORTED_FUNCTIONS` ledger lists the function; once `rust`, the TypeScript export re-exports the shim | met (stage 2) | `tools/arch-lint/src/ported-functions.ts` lists `parseOkf` and `serializeOkf` at stage 2: their TypeScript exports, their `OkfCodecCore['impl']` switch keys (set through `ServerDeps.okfCore`), the Rust exports and the shim members (#2205). Like routing's, the entries stay at stage 2 after a switch to `rust`, because stage 3 deletes the TypeScript the rollback runs; owner decision q26 defers that deletion to the ops step. |
| 17 | Any Unicode table comes from a pinned crate with a version-asserting test | met (accepted deviation: hand-written, engine-asserted) | `whiteboard_model::checks::is_js_space` (`crates/core/model/src/checks.rs`, imported by the codec's `okf/js.rs`) is a hand-written copy of ECMAScript's `WhiteSpace` and `LineTerminator`, the set `String.prototype.trim` strips (`Zs` plus a fixed list). No crate carries that set, so the version assertion is against the engine itself. `packages/codec/src/okf/oracle/js-whitespace.test.ts` enumerates every scalar value `trim` strips in the running engine and holds `js-whitespace.jsonl` (25 code points, one per line) equal to it. The Rust unit test in `crates/core/codec/src/okf/js.rs` holds every scalar value against the same file, natively and on wasm32. A Unicode version that moves `Zs` fails the TypeScript side first. Mutation-checked in both directions: dropping U+FEFF from the Rust set fails, and adding U+0085 (which `char::is_whitespace` counts and `trim` does not) fails. |
| 18 | Exit criteria (QR-33b) recorded in the PR | met | Recorded [below](#qr-33b-exit-criteria), in the PR that moves the switch. |
| 19 | Docs reflect the shipped state | met | `docs/reference/configuration.md` documents `WHITEBOARD_CORE_OKF` (#2205) and `VITE_WHITEBOARD_CORE_OKF` (#2206). The codec, core-wasm and app-web rules describe the switch. `quality-requirements.md`'s status paragraph names this checklist. ADR-0054 carries a dated status note for the OKF envelope, and its index row says the OKF envelope is the second module ported, `rust` by default, `differential` in development and CI. The decisions are untouched. |

## Boundary cost (QR-22b)

Instrument: `packages/codec/src/test-utils/okf-wasm/boundary.ts`, driven by
`scripts/okf-boundary.mjs`
(`node packages/codec/scripts/okf-boundary.mjs --rounds=9 --batch-ms=50`;
`--runtime=node,chromium,workerd`, `--workerd=<binary>`, `--json=<path>`). It
bundles the instrument once with no alias, so every runtime runs the same code
and the TypeScript side is the real `parseOkf` and `serializeOkf`
(`codec-rust` aliases them to the wasm shims, so a baseline taken there would
be Rust twice). It needs the staged artifact (`pnpm rust:build:wasm`, then
`pnpm --filter @kamiazya/whiteboard-core-wasm stage:wasm`).

How each side is known to be what it claims:

- The wasm exports are wrapped and counted. The harness throws if the
  TypeScript batches make any wasm call, or the Rust batches make other than
  one per document.
- Before timing a class the harness reads and writes every document in
  `differential` and throws on a difference or on a call the core declines, so
  no ratio is quoted for a port that answers differently or for a document the
  TypeScript answered in Rust's place.
- Rounds alternate which side goes first; each batch repeats the class until it
  is long enough for the runtime's clock. Numbers are milliseconds per
  iteration (every document of the class once), median with [min-max] over 9
  rounds. "Rust" is the whole call a caller makes: the shim's checks and
  encoding, the copy across and the export.
- Linear memory is read off the instance after each class.
- Chromium is 153 headless shell; workerd is the local `workerd` binary
  (2026-11-09), whose clock advances during synchronous work (a production
  Worker's does not, so these are engine numbers, not a Workers platform
  measurement).

Measured 2026-11-09, one machine, load average 0.6 at the start:

node v24.22.1: init 1.7 ms, linear memory 1.13 MiB after init; ms per iteration, median [min-max] over rounds

| documents | call | text per iteration | TypeScript | Rust (shim + wasm) | Rust/TS (<1: Rust faster) | linear memory after |
|---|---|---|---|---|---|---|
| note (title, 3 tags, 1 KB body), x50 | parseOkf | 39.3 KiB | 1.717 [1.543-1.934] | 0.623 [0.573-1.056] | 0.37 [0.33-0.55] | 1.13 MiB |
| note (title, 3 tags, 1 KB body), x50 | serializeOkf | 39.3 KiB | 0.866 [0.844-0.973] | 0.498 [0.481-0.660] | 0.57 [0.52-0.68] | 1.13 MiB |
| faceted (20 facets, ~3 KB frontmatter), x20 | parseOkf | 77.6 KiB | 14.312 [13.920-19.574] | 3.915 [3.783-4.219] | 0.27 [0.22-0.28] | 1.13 MiB |
| faceted (20 facets, ~3 KB frontmatter), x20 | serializeOkf | 77.6 KiB | 7.164 [6.804-8.416] | 3.705 [3.621-4.446] | 0.53 [0.50-0.59] | 1.13 MiB |
| long body (200 KB body, small frontmatter) | parseOkf | 191.0 KiB | 0.052 [0.049-0.055] | 0.346 [0.305-0.390] | 6.57 [5.85-7.52] | 1.50 MiB |
| long body (200 KB body, small frontmatter) | serializeOkf | 191.0 KiB | 0.011 [0.010-0.015] | 0.005 [0.005-0.007] | 0.51 [0.36-0.58] | 1.50 MiB |
| large frontmatter (~150 KB: 12k tags) | parseOkf | 153.2 KiB | 55.113 [48.131-60.124] | 8.644 [7.385-9.059] | 0.15 [0.14-0.16] | 3.38 MiB |
| large frontmatter (~150 KB: 12k tags) | serializeOkf | 153.2 KiB | 16.157 [15.773-17.062] | 9.415 [9.289-9.648] | 0.58 [0.56-0.60] | 3.38 MiB |

chromium 153.0.8010.12: init 2.2 ms, linear memory 1.13 MiB after init; ms per iteration, median [min-max] over rounds

| documents | call | text per iteration | TypeScript | Rust (shim + wasm) | Rust/TS (<1: Rust faster) | linear memory after |
|---|---|---|---|---|---|---|
| note (title, 3 tags, 1 KB body), x50 | parseOkf | 39.3 KiB | 1.103 [0.969-1.550] | 0.564 [0.516-0.906] | 0.54 [0.37-0.82] | 1.13 MiB |
| note (title, 3 tags, 1 KB body), x50 | serializeOkf | 39.3 KiB | 0.669 [0.655-0.884] | 0.501 [0.494-0.631] | 0.76 [0.56-0.90] | 1.13 MiB |
| faceted (20 facets, ~3 KB frontmatter), x20 | parseOkf | 77.6 KiB | 8.900 [8.500-10.875] | 3.425 [3.250-3.788] | 0.38 [0.33-0.45] | 1.13 MiB |
| faceted (20 facets, ~3 KB frontmatter), x20 | serializeOkf | 77.6 KiB | 5.375 [5.150-5.512] | 3.712 [3.625-3.925] | 0.69 [0.66-0.74] | 1.13 MiB |
| long body (200 KB body, small frontmatter) | parseOkf | 191.0 KiB | 0.055 [0.054-0.069] | 0.371 [0.359-0.386] | 6.48 [5.57-6.75] | 1.50 MiB |
| long body (200 KB body, small frontmatter) | serializeOkf | 191.0 KiB | 0.008 [0.007-0.008] | 0.005 [0.005-0.005] | 0.69 [0.67-0.73] | 1.50 MiB |
| large frontmatter (~150 KB: 12k tags) | parseOkf | 153.2 KiB | 29.850 [27.800-35.850] | 7.000 [6.600-7.400] | 0.23 [0.20-0.26] | 3.38 MiB |
| large frontmatter (~150 KB: 12k tags) | serializeOkf | 153.2 KiB | 12.063 [11.662-14.675] | 9.600 [9.512-10.038] | 0.79 [0.65-0.83] | 3.38 MiB |

workerd 2026-11-09: init 1.0 ms, linear memory 1.13 MiB after init; ms per iteration, median [min-max] over rounds

| documents | call | text per iteration | TypeScript | Rust (shim + wasm) | Rust/TS (<1: Rust faster) | linear memory after |
|---|---|---|---|---|---|---|
| note (title, 3 tags, 1 KB body), x50 | parseOkf | 39.3 KiB | 1.141 [1.141-1.234] | 0.563 [0.547-0.844] | 0.49 [0.48-0.71] | 1.13 MiB |
| note (title, 3 tags, 1 KB body), x50 | serializeOkf | 39.3 KiB | 0.750 [0.742-0.773] | 0.461 [0.461-0.563] | 0.62 [0.61-0.73] | 1.13 MiB |
| faceted (20 facets, ~3 KB frontmatter), x20 | parseOkf | 77.6 KiB | 9.500 [9.375-9.625] | 3.875 [3.750-4.125] | 0.40 [0.39-0.44] | 1.13 MiB |
| faceted (20 facets, ~3 KB frontmatter), x20 | serializeOkf | 77.6 KiB | 5.938 [5.625-6.125] | 3.875 [3.750-4.063] | 0.65 [0.61-0.70] | 1.13 MiB |
| long body (200 KB body, small frontmatter) | parseOkf | 191.0 KiB | 0.059 [0.058-0.061] | 0.313 [0.309-0.349] | 5.36 [5.23-5.85] | 1.50 MiB |
| long body (200 KB body, small frontmatter) | serializeOkf | 191.0 KiB | 0.009 [0.008-0.009] | 0.005 [0.005-0.006] | 0.60 [0.57-0.63] | 1.50 MiB |
| large frontmatter (~150 KB: 12k tags) | parseOkf | 153.2 KiB | 32.500 [31.000-34.500] | 7.500 [7.500-8.000] | 0.23 [0.22-0.26] | 3.38 MiB |
| large frontmatter (~150 KB: 12k tags) | serializeOkf | 153.2 KiB | 13.500 [13.000-14.000] | 10.250 [10.000-10.750] | 0.76 [0.71-0.79] | 3.38 MiB |

What it says:

- Rust is faster for every class whose cost is the frontmatter, on every
  runtime, and more so the larger the frontmatter: a read is a quarter to a
  sixth of the TypeScript's at 12k tags, a write between a half and four fifths.
- The one slower class is a read of a long body: the shim hands the whole text
  across (and checks it is well formed) to learn where the body starts, where
  the TypeScript only searches for the closing fence. It costs about 0.3 ms per
  200 KiB, and a text past 256 KiB is answered by the TypeScript without
  crossing (the cap in `crates/input-caps.json`). A write never carries the
  body.

## QR-33b exit criteria

| Criterion | Recorded |
|---|---|
| Port shape | Structure-preserving. `crates/core/codec/src/okf/{document,fence,schema,write}.rs` follow `parse.ts`, `schema.ts` and `serialize.ts`. `js.rs` exists to keep the JavaScript behaviours the TypeScript leans on: property enumeration order, `trim`'s whitespace, UTF-16 code unit order and Zod's length checks. |
| TypeScript deletion deadline | Deferred past the default by owner decision q26: the TypeScript OKF envelope is deleted with the ops step (ADR-0054 step 10), when the daemon's tool layer moves to Rust and no TypeScript caller is left. |
| Rollback | Set `WHITEBOARD_CORE_OKF=ts` (daemon, read at start) or build the web app with `VITE_WHITEBOARD_CORE_OKF=ts` (read at build time). `differential` also answers with the TypeScript, and a call the core declines is answered by the TypeScript in every mode. |
| Freeze lift | `packages/codec/src/okf` is frozen for feature work until the switch is `rust` and the TypeScript is deleted; after that, features go to Rust only (ADR-0054 decision 23). |
