# Parity checklist: the JSON Canvas codec

The [QR-33a](../quality-requirements.md) checklist for the third ported
module: `parseSpatial` and `serializeSpatial` in `packages/codec/src/spatial`
(Rust: `whiteboard_codec::json_canvas` in `crates/core/codec`). It is filled in
as the module stands, so a row says what is shown, not what is intended.

The codec is reached through two wasm exports, `json_canvas_parse` and
`json_canvas_serialize` (ABI 17), and `@kamiazya/whiteboard-core-wasm`'s
`parseSpatial` and `serializeSpatial`. The `CoreImpl` switch is codec's
`spatialCodec` (`src/spatial/spatial-core.ts`), set by `WHITEBOARD_CORE_SPATIAL`
in the daemon, where it defaults to `ts`; the web app's `VITE_WHITEBOARD_CORE_SPATIAL`
is the next increment. The switch **may not move to `rust` until every row
below is `met` or `n/a`**; owner decision q39 is that it then moves to `rust`
despite row 12's cost, and the TypeScript is deleted on the default schedule.

Ports, in order:
- the spatial leaf types and the whole canvas, generated from
  `contracts/model/spatial.schema.json` into `whiteboard-model` (#2216, #2218);
- the codec, held to `json-canvas.jsonl` (#2220);
- the wasm exports, the shim, the layer 1 and layer 2 differentials and the
  boundary measurement (this checklist, from row 6 on).

## What was ported

`parseSpatial` is three steps: `JSON.parse`; a refusal of a file that carries
`x-whiteboard.comments`; then `jsonCanvasDocumentSchema.safeParse` and the lift
of `fromJsonCanvas`. `serializeSpatial` is `toJsonCanvas`, then for the strict
mode `strictDegrade` and a re-validation against the same wire schema, then
`JSON.stringify`.

| TypeScript | Rust (`crates/core/codec/src/json_canvas/`) |
|---|---|
| `JSON.parse` | `json.rs`: a reader of the grammar, with the host's own rules (a repeated key keeps its first place and takes its last value; `__proto__` is an ordinary key; integer-like keys enumerate first) |
| `JSON.stringify` | `stringify.rs`, with `whiteboard-det`'s `js_number_to_string` for numbers |
| `jsonCanvasDocumentSchema`, the node and edge schemas, `z.int()`, `z.union` | `wire.rs`, `schema.rs`: each leaf answers its value and its issues, and an issue says whether Zod goes on checking the same value |
| `x-whiteboard` at its three sites, `canvasLineSchema` | `extension.rs`: `.optional().catch(undefined)` at every bucket, so a malformed one costs the bucket |
| `z.url()` | `url.rs` |
| `toJsonCanvas` | `project.rs` |
| `fromJsonCanvas` | the lift at the end of `wire.rs` |

The wire schema is **not** in `contracts/`: it is the codec's own declaration of
JSON Canvas 1.0 plus the extension (ADR-0037), written once in Zod and once
here. The model's leaves it reuses (`SpatialNode`, `CanvasLine`, the facet and
colour types) are the generated ones.

## QR-33a

| # | Check | Status | Evidence, or what is missing |
|---|---|---|---|
| 1 | Contracts in `contracts/`, generated into both languages, `codegen --check` clean | met (accepted deviation: the wire schema) | The model the codec reads into and writes from is generated (`whiteboard_model::spatial`), and `cargo xtask codegen --check` is clean. The wire shape is a codec declaration (ADR-0037), not a contract, so it exists twice by hand and the recorded oracle (row 7) is what holds the two equal. The model's checks the wire does not run (below) stay in `whiteboard_model::checks`. |
| 2 | Layer per the architecture map; dependencies equal the allowed set; core wasm imports nothing | met | `whiteboard-codec` gains no dependency: `whiteboard-det` and `whiteboard-model`, as before. `cargo xtask arch-map` and the wasm32 import scan run in the `rust` job through `pnpm rust:check`. |
| 3 | Clippy, fmt and the core lint set pass with no new `#[expect]` outside a ledger | met | `pnpm rust:check` passes. The port adds no `#[expect]` to the crate. |
| 4 | Native unit tests red-first; every QR-14a property class present through the shared prelude, with reachability floors, committed regressions, no pinned seed, each mutation-checked | met | A parser and serializer are QR-14a's first class. The recorded oracle came first and was red until the codec was written; the examples and properties were written after the codec, against the oracle's answers. `tests/json_canvas_properties.rs` (4 properties, each with a reachability floor measured and set at about half of what its generator reaches): a canvas the projection can express reads back as itself (floors on an embed, ink, a bent edge, a link, facets and a fractional ink coordinate); the strict text states exactly what JSON Canvas does and nothing under `x-whiteboard`; a damaged text is refused or settles after one write and read; and a text from three sources (arbitrary, token soup, a damaged serialization) is answered without a panic. `tests/json_canvas_examples.rs` (34 tests) says each behaviour in words. Each property was shown to fail on a planted change, through `.claude/scripts/mutate.mjs`: dropping `versionRef` from the embed's projection fails the round trip; letting the strict mode keep a node's extension fails the strict property; ink that drifts by one on every write fails the round trip and the settling property; and a panic in the number reader fails the totality property. Damaged serializations are in the totality property's mix because arbitrary strings and token soup were 99% syntax errors (1 to 3 draws in 200 got past JSON) and never reached the schema. |
| 5 | Every port implementation the module touches runs its conformance suite | n/a | The codec touches no store or sync port; it is a pure function of a text or a canvas. |
| 6 | Layer 1: every TypeScript test passes against Rust, pinned numbers identical, no expectation edited | met | `pnpm --filter @kamiazya/whiteboard-codec exec vitest run -c vitest.rust.config.ts` (project `codec-rust`) runs the five spatial suites that reach `parseSpatial` or `serializeSpatial` (`parse`, `serialize`, `json-canvas-extension`, `extension-contract.property`, `codecs.property`: 56 tests) with `./parse.js` and `./serialize.js` answered by the core (`src/test-utils/spatial-wasm/`), unchanged and with no expectation edited. The core answers each, and a decline fails the test it happens in (`setup.ts`): **no test is excused a decline**, because none of these suites provokes one. Two things the run found are fixed, not tolerated (below): the refinement messages and the length check. One test is run on the TypeScript rather than the core, from the both-sided ledger `typescript-only.ts`: `strict mode re-validates the degraded document and throws if it is not schema-valid` replaces `./degrade.js` with a broken one through `vi.doMock`, which can only break the TypeScript's own composition; the core re-validates in Rust, which `the_strict_mode_refuses_a_canvas_the_wire_schema_refuses_and_the_extended_does_not` and the live differential hold. A suite that reaches neither function is not run (the projections, the degradation, the schemas the core does not port), and `spatial-layer-one.rust.test.ts` fails on a suite that reaches one and is not listed. |
| 7 | Layer 2: property differential with exact equality, shown to fail on a planted change | met | `src/spatial/wasm.rust.test.ts` holds `Core.parseSpatial` and `Core.serializeSpatial` to the TypeScript live: the recorded corpus through the wasm (1,400 texts, 600 canvases), and three generated properties (1,500 texts, 1,000 model-shaped canvases some with fields set to `undefined`, 400 canvases from the model's own arbitrary), exact on the canvas (every number by its bits, key order, prototypes), a refusal's stage, message and each issue's path and code, a refinement's text, and the written bytes. Every decline is judged by machinery that shares nothing with the core (`earned.ts`: `JSON.parse`, a scan, a walk of the canvas against the contract's field names), and the run states what it reached. The properties found four defects the recorded oracle could not, each fixed: a number halfway between two spellings (`1365915630079496.25` printed `.3`), a value with a `length` (`[]` as an id) refused once where Zod refuses it twice, a refinement's message missing, and an edge's key order. Shown to fail on a planted change: see row 11 for the planted changes the mutation gate caught; the property itself failed on each defect above before its fix. |
| 8 | Layer 3: shared fixtures and goldens byte-identical natively and on wasm | met | `cargo xtask cross-target` runs `whiteboard-codec`'s tests natively and on wasm32 under Node with the same count (108), the recorded replay, the examples and the properties among them. The first run on wasm32 found a property floor the generator reached too rarely (18 of 200 against 20: a double drawn at random is almost always a whole number); the ink is denser now and the floors sit at half of what it reaches. |
| 9 | Every tolerated difference is a both-sided ledger entry | met (one difference not compared, one test on the TypeScript) | The core tolerates no difference in an answer it gives. Two things are not compared and are named: the **words of a Zod issue** (`Invalid input: wrong type` for its code, where Zod words the expected and received types; the same stance as the OKF shim, and the recorded oracle never compared them), except for a refinement the schema states in code, whose text is carried and held equal (`edge "e" references nonexistent toNode "x"`); and the one test in row 6 that replaces a module inside the TypeScript. The declines are listed below. |
| 10 | `differential` has run in CI and in dogfooding with no unexplained mismatch | not yet (daemon wired) | The daemon runs JSON Canvas in `differential` in CI's `mcp-node` shards and the packaged smoke, and the dev scripts set it, with `WHITEBOARD_CORE_MISMATCH=throw` in CI, so a difference or a decline fails the run (`event: 'spatial-declined'` is the logged record otherwise). The web app's switch, and its browser jobs, are the next increment. |
| 11 | `cargo mutants --in-diff` clean or ledgered; coverage at or above the crate's floor | met | `cargo mutants --in-diff` over this increment's Rust (`spatial-codec` to HEAD): 210 mutants in the exports, the wire, the length check, the refinement messages and the tie rule, 173 caught, 30 unviable, 7 missed, 0 timed out. All seven were closed: a write exactly at the cap was untested (the boundary the OKF export also pins); a `-Infinity` arm that `Number()` reads as `NaN` anyway was removed; and four survivors in the tie rule were one equivalent guard (a 15-digit spelling cannot be halfway, so the `k < 16` filter was a speed-up and was dropped), one match arm that Rust's own half-up rounding already satisfies (removed, and the odd-lower case is a test now), and `&&` in the halfway test, which needed a value just past halfway whose lower spelling is even (four, from a search against `String(x)`, pinned). The three files that changed were run again: 68 mutants, 67 caught, 1 unviable, 0 missed. Coverage (`cargo xtask coverage`): `bindings/wasm` 87.99% lines and 82.47% regions against floors of 82 and 77 (raised to 87 and 82), `core/codec` 99.14% and 98.24% (floors raised from 98 and 97 to 99 and 98), `core/det` 99.73% and 99.60% (98 and 98 to 99 and 99). |
| 12 | One call per user operation; boundary cost measured on browser, Node and workerd against the TypeScript, result in the PR body | met for the measurement; it decides the switch | One call per operation holds: a read is one `json_canvas_parse` and a write one `json_canvas_serialize`, and `scripts/spatial-boundary.mjs` fails if the Rust batches make any other number of wasm calls or the TypeScript batches make any. **The Rust path is slower than the TypeScript at every size, on every runtime measured: reads by 5x to 8x and writes by 15x to 25x** (the ratio is Rust over TypeScript) (Node 24 and Chromium 153; no workerd binary here, so workerd is unmeasured), [below](#boundary-cost-qr-22b). A typical board (60 nodes, 80 edges, 17 KiB) is read in 0.23 ms by the TypeScript and 1.8 ms through the core, and written in 0.06 ms against 1.1 ms. The cost is not the crossing: of the 1.8 ms, the export alone is 1.2 ms (the reader, the schema, the lift, building the wire), the host's `JSON.parse` of its answer 0.13 ms and the rest the shim building the canvas from it. It is that `JSON.parse` and `JSON.stringify` are native in every host and the TypeScript's whole read is a native parse plus Zod, where the core parses the text again in wasm (about 14 MB/s here) and sends the result back across as text; a write has no native step to beat, because the TypeScript's is a projection and `JSON.stringify`. So the Rust path buys nothing for time on the host, and unless the answer is consumed in Rust without crossing back, the default for this module should stay `ts`. That is the number the switch increment decides on; this one reports it. |
| 13 | Artifact size within its ledger, peak memory reported, Workers budgets measured | met for the size and the memory; the Workers budgets are unmeasured | Size: `crates/wasm-size-ledger.json`'s ceiling is raised by hand from 907500 to 1095500 for the 1094982-byte cargo artifact, 187954 more than before; the shipped, stripped module is 632603 bytes against 526644. Nothing called the codec before, so the linker had dropped it; the exports make the reader, the schema, the URL check, the projection, the writer and the canvas wire reachable. Memory, by `scripts/spatial-boundary.mjs`: 1.13 MiB after init, 1.38 MiB after the 17 KiB boards, 12.88 MiB after a 700 KiB one and **51.75 MiB after the 3.1 MiB one** (about 16 times the text, from the text, the tree, the answer and the wire all being live at once), the same on Node and Chromium; linear memory does not shrink, so an instance that has read a large board keeps it. Startup (`coreFrom`, module compiled) is 2.6 to 3.3 ms on Node and 2.8 to 3.2 ms on Chromium. The Workers budgets (CPU and memory per request) need a workerd binary this environment does not have and are not measured. |
| 14 | Every untrusted-input entry has caps and a fuzz target, seeded and run, no open crash | met | `crates/input-caps.json` declares both exports, `whiteboard-wasm::json_canvas::json_canvas_parse` and `json_canvas_serialize`, each with `maxBytes` 4 MiB, `maxDepth` and `maxMillis` and the measurement behind them, naming the fuzz targets `json_canvas_wasm_parse` and `json_canvas_wasm_serialize`. The first reads any text and holds the export to the codec's own answer for it (a canvas, a refusal of each class, or a decline) and to its documented shapes; the second reads any text as a canvas wire, in both modes, and holds the answer to its documented shapes, the extended mode never answering a schema refusal. Seeds: the seven texts of `json_canvas_parse` (its links split into an accepted and a declined seed) and seven wires (`crates/fuzz/seeds/json_canvas_wasm_*`), checked by `the_canvas_seeds_are_wires_the_export_decodes`. `cargo xtask inputs` holds the registry and `crates/fuzz` equal. A 60 s local run of each target (`RUST_FUZZ_SECONDS=60 node tools/checks/src/rust-fuzz.mjs pr --targets json_canvas_wasm_parse,json_canvas_wasm_serialize`) found nothing; the serialize target made 4.46M executions. The `maxMillis` of each is measured on Node wasm at the cap (parse 1146 ms worst, serialize 344 ms; the figures are in the registry entry). |
| 15 | Logging through the `log` facade; `thiserror` convention; poison-and-recover covers held state | n/a | The crate does not log. It answers a refusal or a decline as a value, and holds no state across calls. |
| 16 | `PORTED_FUNCTIONS` ledger lists the function; once `rust`, the TypeScript export re-exports the shim | met (stage 2) | `tools/arch-lint/src/ported-functions.ts` lists `parseSpatial` and `serializeSpatial`, each against `SpatialCodecCore`'s key, `ServerDeps.spatialCore`, the export it reaches and the shim member; the checker holds every key of the switch listed and every entry real. Stage 3 (the TypeScript export a re-export of the shim) moves with the TypeScript's deletion. |
| 17 | Any Unicode table comes from a pinned crate with a version-asserting test | met (no table) | The codec carries none: it uses `is_js_space` (`whiteboard-model`, checked against the engine by the OKF checklist's row 17) and declines the hosts that need UTS 46 (below). |
| 18 | Exit criteria (QR-33b) recorded in the PR | met | [Below](#qr-33b-exit-criteria). |
| 19 | Docs reflect the shipped state | met | ADR-0054 carries a dated status note for the exports (2026-11-10), with the boundary result, and the earlier note for the port. |

## Divergences between the TypeScript and the contract

The contract (`spatial.schema.json`) and the TypeScript wire schema were written
in different increments, and the port had to choose which one to reproduce. It
reproduces the TypeScript, because the TypeScript is the oracle, and records
each place the two disagree. None changes the TypeScript here.

1. **`parseSpatial` does not run the model's own checks.** The contract's
   `spatialCanvasIntegrity` says edge and line ids are unique across both
   collections and every end a line names is a node that exists. The wire
   schema checks node ids, edge ids among edges, and an edge's two nodes, and
   nothing about lines, and `fromJsonCanvas` does not validate what it builds.
   A file whose line shares an edge's id, or whose line ends on a node that is
   not there, is read; the Rust port reads it the same and says so in
   `the_model_s_own_checks_on_ink_are_not_the_wire_s`. Applying
   `whiteboard_model::checks::spatial_canvas_integrity` would refuse such a
   file, which is a behaviour change owed to a decision, not a port.
2. **Zod skips a `__proto__` key in a record.** A facet bucket
   `{"__proto__": 1, "a.b/v0": 2}` is valid and reads as `{"a.b/v0": 2}`: the
   record loop `continue`s over the key before the key check runs. The port
   copies it. A payload's own `__proto__` is kept, since the payload is
   `z.unknown()`.
3. **A link's `url` is rewritten.** `z.url()` returns the text trimmed and with
   tabs and line breaks removed, so `"  https://exa\tmple.com "` reads as
   `https://example.com`. The port copies it.
4. **`serializeSpatial` is not total.** The strict mode re-validates and throws
   a `ZodError` for a canvas whose link is not a URL, whose edge names a node
   that is not there, or whose id repeats; the extended mode validates nothing
   and writes all three. The Rust `serialize` answers the first as a
   `WriteFailure::Schema` with the same issues, and the second as text.
5. **The two arms of a node's `x-whiteboard` are not symmetric.** An embed
   ignores a key it does not name; the facets-and-tags arm refuses one and the
   whole bucket is lost. `{"facets": {...}, "extra": 1}` loses its facets,
   `{"kind":"embed", "documentId": ..., "extra": 1}` does not.

## What the port declines

A decline is the core refusing to answer so that the caller asks the
TypeScript. At the crate it is a `Decline`; through the export it is
`["refused", code, class]` with the registry's code and the class of input that
earned it, and the shim throws it as a `CoreInputRefused` carrying both
(`code`, `detail`). The live differential counts each and checks, without
asking the core, that the input is one that earns it (`earned.ts`).

| Decline (crate) | Export code and class | Input | Why |
|---|---|---|---|
| `LoneSurrogate` | `malformed` / `lone-surrogate` | a `\uD800`-class escape not joined to its pair, or a raw unpaired surrogate in the text | a Rust `String` cannot hold it; `JSON.parse` keeps it. A raw one never reaches the export: the shim checks `isWellFormed` first |
| `TooDeep` | `malformed` / `too-deep` | nesting past 64 on the way in | the reader recurses |
| `TooLarge` | `input-too-large` / `too-large` | a text over 4 MiB, or a canvas wire over 4 MiB | the caps in `input-caps.json`; the wire of a canvas is about 18% bigger than the text written from it (3,802,356 bytes against 3,221,606 for the largest board measured), so the writer's cap is met by a board whose text is about 3.4 MiB |
| `Url` | `malformed` / `url` | a link whose host needs UTS 46 (a non-ASCII or `xn--` host), percent-decoding, an IPv6 literal, or a `file` URL | the answer needs tables this crate does not carry |
| `Unwritable` | `malformed` / `unwritable` | a value kept as big-integer digits | `JSON.stringify` throws on a bigint |
| (the wire) | `malformed` / `wire` | a canvas the wire does not carry: a key the contract does not name, a field of another kind, a class instance, a function, a lone surrogate in a string or key, a hole or an `undefined` in a list, nesting past 100, or a wire past serde_json's own depth | the export reads the canvas strictly, and what it does not read the TypeScript answers. A key set to `undefined` is not among them: it is left out, as `JSON.stringify` leaves it |

In the recorded corpus the core reads 765 of 1,400 texts to a canvas and
refuses 425 at the schema, 142 as not JSON and 5 as carrying comments, which
are the TypeScript's answers exactly, and declines 63: 39 for a link, 21 for a
surrogate escape and 3 for nesting. Of 600 canvases, 457 are written byte for
byte, 128 are refused by the strict mode with the TypeScript's issues, and 15
are declined for a link. Layer 1 meets **no** decline in its five suites.

## Found by running the TypeScript's tests and a generator against the core

None changes what the TypeScript answers except the last.

1. **A refinement's message was dropped.** `parse.test.ts` reads the text of a
   repeated-id issue (`duplicate node id "n1"`). The core named the issue by
   path and code only. A refinement the wire schema states in code now carries
   its message (`Issue.message`, the third element of an issue on the wire); the
   words Zod writes for a type or a format are still not reproduced.
2. **A number halfway between two spellings printed the wrong one.**
   `1365915630079496.25` is exactly between `...496.2` and `...496.3`; ECMA-262
   picks the even last digit and Rust's `{:e}` rounds half up. The shortest
   spelling is now settled the way the spec says (`whiteboard-det`), which also
   corrects any other module that prints a number. The recorded oracle holds no
   such number.
3. **`min(1)` is run on anything with a `length`.** Zod checks an empty array,
   or an object whose `length` is below one by the host's relational
   comparison, as too short after it has refused it as the wrong type. The port
   knew the empty string only. The comparison is reproduced (`length.rs`:
   `Number()` of a string, `join` of an array, `NaN` for an object) and checked
   against Zod on 45 values.
4. **An edge's keys were in the contract's order, not the lift's.** The recording
   fixes one order for both sides, so it could not see that `fromJsonCanvas`
   puts `bends` last. A host sees an object's key order, so the wire writes an
   edge as the TypeScript lifts it.
5. **A lifted line could hold `facets: undefined`.** The wire schema's
   `.catch(undefined)` left the key present on a line whose facet bucket was
   malformed, which no other lifted element does and the core cannot answer. The
   lift now leaves the key out. This is the one change to the TypeScript's
   answer, and it is one a strict comparison sees and a serialiser does not.

## Boundary cost (QR-22b)

Instrument: `packages/codec/src/test-utils/spatial-wasm/boundary.ts`, driven by
`scripts/spatial-boundary.mjs`
(`node packages/codec/scripts/spatial-boundary.mjs --rounds=9 --batch-ms=50`;
`--runtime=node,chromium,workerd`, `--workerd=<binary>`, `--json=<path>`), built
and checked as the OKF one is (`okf-codec.md`): one bundle with no alias so the
TypeScript side is the real `parseSpatial` and `serializeSpatial`, the wasm
exports counted (none in a TypeScript batch, exactly one per canvas in a Rust
one), every class read and written by both before it is timed with any
difference thrown, alternating rounds, and linear memory read off the instance
after each class. Milliseconds per iteration, where an iteration is every
canvas of the class once (so the small class is 200 reads), median with
[min-max] over 9 rounds. "Rust" is the whole call a caller makes: the shim's
checks and encoding, the copy across and the export, and the decode of the
answer.

The canvases are boards of text nodes in a grid with edges between neighbours,
a colour on one node in five and a facet on one in ten. The largest, 11,000
nodes and 12,800 edges (3.1 MiB of text), is about as big as the writer takes:
its wire is 3.63 MiB against the entry's 4 MiB. A bigger one is declined by the
shim (`input-too-large`) and written by the TypeScript. The reader's cap is
4 MiB of text.

Measured 2026-11-10, one machine, no other load (a mutation run had just
finished). Two runs on Node and on Chromium agreed to within the spread shown;
the second is below. No workerd binary was available, so workerd is not
measured.

**Node 24**

node v24.22.1: init 3.3 ms, linear memory 1.13 MiB after init; ms per iteration, median [min-max] over rounds
| canvases | call | text per iteration | TypeScript | Rust (shim + wasm) | Rust/TS (<1: Rust faster) | linear memory after |
|---|---|---|---|---|---|---|
| small (3 nodes, 2 edges), x200 | parseSpatial | 150.3 KiB | 2.755 [2.459-4.406] | 14.208 [13.367-17.623] | 5.06 [3.11-6.66] | 1.13 MiB |
| small (3 nodes, 2 edges), x200 | serializeSpatial | 150.3 KiB | 0.626 [0.602-1.023] | 10.280 [9.686-11.944] | 15.91 [11.68-18.38] | 1.13 MiB |
| typical (60 nodes, 80 edges, ~17 KiB), x10 | parseSpatial | 172.7 KiB | 2.203 [2.017-2.721] | 14.604 [13.818-15.511] | 6.57 [5.43-7.69] | 1.38 MiB |
| typical (60 nodes, 80 edges, ~17 KiB), x10 | serializeSpatial | 172.7 KiB | 0.588 [0.549-0.784] | 11.121 [10.166-13.960] | 18.59 [14.36-21.00] | 1.38 MiB |
| large (~700 KiB: 2,400 nodes, 3,000 edges) | parseSpatial | 698.9 KiB | 9.245 [8.614-10.942] | 52.665 [51.293-55.085] | 5.79 [4.81-6.33] | 12.88 MiB |
| large (~700 KiB: 2,400 nodes, 3,000 edges) | serializeSpatial | 698.9 KiB | 2.577 [2.422-2.989] | 40.912 [39.476-47.269] | 15.45 [14.14-18.55] | 12.88 MiB |
| largest (~3.1 MiB: 11,000 nodes, 12,800 edges) | parseSpatial | 3146.1 KiB | 48.362 [43.415-60.414] | 271.925 [249.028-276.665] | 5.54 [4.58-6.19] | 51.75 MiB |
| largest (~3.1 MiB: 11,000 nodes, 12,800 edges) | serializeSpatial | 3146.1 KiB | 11.855 [11.014-13.568] | 196.884 [192.754-207.666] | 17.10 [14.47-18.41] | 51.75 MiB |

**Chromium 153**

chromium 153.0.8010.12: init 3.2 ms, linear memory 1.13 MiB after init; ms per iteration, median [min-max] over rounds
| canvases | call | text per iteration | TypeScript | Rust (shim + wasm) | Rust/TS (<1: Rust faster) | linear memory after |
|---|---|---|---|---|---|---|
| small (3 nodes, 2 edges), x200 | parseSpatial | 150.3 KiB | 2.019 [1.794-3.097] | 12.456 [11.850-17.962] | 6.33 [5.80-7.53] | 1.13 MiB |
| small (3 nodes, 2 edges), x200 | serializeSpatial | 150.3 KiB | 0.650 [0.503-0.769] | 10.550 [9.895-12.202] | 16.22 [14.13-20.38] | 1.13 MiB |
| typical (60 nodes, 80 edges, ~17 KiB), x10 | parseSpatial | 172.7 KiB | 1.953 [1.719-2.831] | 13.581 [12.191-17.731] | 6.72 [5.71-8.00] | 1.38 MiB |
| typical (60 nodes, 80 edges, ~17 KiB), x10 | serializeSpatial | 172.7 KiB | 0.462 [0.423-0.626] | 11.073 [10.769-11.799] | 24.65 [17.87-25.91] | 1.38 MiB |
| large (~700 KiB: 2,400 nodes, 3,000 edges) | parseSpatial | 698.9 KiB | 6.650 [6.038-10.787] | 49.075 [46.662-53.563] | 7.38 [4.97-8.11] | 12.88 MiB |
| large (~700 KiB: 2,400 nodes, 3,000 edges) | serializeSpatial | 698.9 KiB | 1.984 [1.869-2.713] | 42.531 [38.444-51.753] | 20.78 [19.08-23.51] | 12.88 MiB |
| largest (~3.1 MiB: 11,000 nodes, 12,800 edges) | parseSpatial | 3146.1 KiB | 30.050 [28.100-46.400] | 235.800 [218.000-289.200] | 7.85 [4.75-9.25] | 51.75 MiB |
| largest (~3.1 MiB: 11,000 nodes, 12,800 edges) | serializeSpatial | 3146.1 KiB | 9.900 [9.512-11.025] | 192.962 [178.375-196.075] | 18.93 [17.02-20.29] | 51.75 MiB |

Where the time goes, for the 17 KiB board on Node (read, ms): the host's own
`JSON.parse` of the text is 0.08, the whole TypeScript read (parse, Zod, lift)
0.23, the core's export alone 1.19 (14 MB/s: the same text is parsed again in
wasm, checked against the wire schema, lifted and written out as a wire), the
host's `JSON.parse` of that answer 0.13 and the shim's decode into objects the
remaining 0.5, 1.81 in all. A write is `JSON.stringify` of a projection in the
TypeScript (0.06) against encoding the canvas, parsing the wire in Rust,
projecting and writing the text, 1.1.

## QR-33b exit criteria

| Criterion | Recorded |
|---|---|
| Port shape | Structure-preserving. `json_canvas/{wire,extension,schema,project}.rs` follow `json-canvas.ts`, `projection.ts` and `parse.ts`/`serialize.ts`; `json.rs`, `stringify.rs` and `url.rs` exist to keep the host behaviours the TypeScript leans on. |
| TypeScript deletion deadline | ADR-0054's default: the release after the first one that defaults to `rust`. |
| Rollback | `WHITEBOARD_CORE_SPATIAL=ts` in the daemon, read at start; it is the default until the checklist is met. |
| Freeze lift | `packages/codec/src/spatial` is frozen for feature work until the switch is `rust` and the TypeScript is deleted (ADR-0054 decision 23). |
