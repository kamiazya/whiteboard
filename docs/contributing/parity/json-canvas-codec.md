# Parity checklist: the JSON Canvas codec

The [QR-33a](../quality-requirements.md) checklist for the third ported
module: `parseSpatial` and `serializeSpatial` in `packages/codec/src/spatial`
(Rust: `whiteboard_codec::json_canvas` in `crates/core/codec`). It is filled in
as the module stands, so a row says what is shown, not what is intended.

**This is the port only.** There is no wasm export, no `CoreImpl` switch and no
`PORTED_FUNCTIONS` entry yet: those are the next increments, and every row
that needs them says `not yet`. The switch **may not move to `rust` until
every row below is `met` or `n/a`**.

Ports, in order:
- the spatial leaf types and the whole canvas, generated from
  `contracts/model/spatial.schema.json` into `whiteboard-model` (#2216, #2218);
- the codec, held to `json-canvas.jsonl` (this checklist).

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
| 6 | Layer 1: every TypeScript test passes against Rust, pinned numbers identical, no expectation edited | not yet | Needs the wasm export and a `codec-rust` re-run of `src/spatial/*.test.ts`. |
| 7 | Layer 2: property differential with exact equality, shown to fail on a planted change | partly met | The recorded oracle is the native half. `packages/codec/src/spatial/oracle/json-canvas-recorded-oracle.test.ts` fails when the TypeScript stops answering as recorded, and `crates/core/codec/tests/json_canvas_oracle.rs` replays it: 1,400 texts and 600 canvases, every document, refusal stage, issue path and code, and byte equal. A generated differential through the artifact needs the export. Shown to fail on a planted change: `abs() > MAX_SAFE_INTEGER` made `>=` fails 647 of 1,400 texts and 83 of 600 canvases. |
| 8 | Layer 3: shared fixtures and goldens byte-identical natively and on wasm | met | `cargo xtask cross-target` runs `whiteboard-codec`'s tests natively and on wasm32 under Node with the same count (108), the recorded replay, the examples and the properties among them. The first run on wasm32 found a property floor the generator reached too rarely (18 of 200 against 20: a double drawn at random is almost always a whole number); the ink is denser now and the floors sit at half of what it reaches. |
| 9 | Every tolerated difference is a both-sided ledger entry | met (nothing tolerated) | The port tolerates no difference in an answer it gives; it declines the inputs below, and the recorded oracle counts them. A refusal's message text is not compared, and not reproduced. |
| 10 | `differential` has run in CI and in dogfooding with no unexplained mismatch | not yet | Needs the switch. |
| 11 | `cargo mutants --in-diff` clean or ledgered; coverage at or above the crate's floor | met | `cargo mutants -p whiteboard-codec --in-diff` over the port's diff against `spatial-full`: 426 mutants, 297 caught, 129 unviable, 0 missed, 0 timed out. The first run found 9 missed and 1 timed out. Four were a test owed (the 4 MiB cap and its exact boundary, a repeated key past the sixteenth, a 64-point list of bends, a trailing dot after an IPv4 address); one was a coordinate past the largest double that no recorded text spelled; two were code that said nothing and was removed (a `+ 0` the text writer makes redundant, an abort check the document's final answer already makes); one was a scan below sixteen keys that no test could tell from an index, removed at a measured 6 to 17% on node lists; and one was a sign test whose only difference was at zero. The timeout is the reader's `bump` made a no-op, which hangs every parse like the YAML cursor's, ledgered in `.cargo/mutants.toml` with the same reason. Coverage (`cargo xtask coverage`): `core/codec` 99.20% lines and 98.36% regions against floors of 98 and 97 (98.67% and 97.99% before); the floor is unchanged. |
| 12 | One call per user operation; boundary cost measured on browser, Node and workerd against the TypeScript, result in the PR body | not yet | Needs the export. Natively in release, the reader takes 98 to 773 ms for a 4 MiB text of the shapes in `input-caps.json`'s entry, and the writer 75 to 245 ms for the same canvases. `JSON.parse` is native in every host, so the Rust reader's gain is the validation and the lift, not the parse; the boundary measurement decides whether the call is worth making. |
| 13 | Artifact size within its ledger, peak memory reported, Workers budgets measured | met for the size; the rest needs the export | Nothing exports the codec, so the shipped artifact should not have moved, and it grew by 225 bytes and one function when measured on its own (901294 to 901519): the link-time layout of a larger crate, as the ledger records for the generated types before it. On top of main's OKF fault list it measures 907028 bytes, 213 more than main, under main's 907500 ceiling, so `crates/wasm-size-ledger.json` keeps that ceiling and records the growth. Peak memory and the Workers budgets are measured with the export. |
| 14 | Every untrusted-input entry has caps and a fuzz target, seeded and run, no open crash | met | `crates/input-caps.json` declares `whiteboard-codec::json_canvas::parse` with `maxBytes` 4 MiB, `maxDepth` 64 and `maxMillis` 2000 and the measurement behind each, naming the fuzz target `json_canvas_parse`, which parses any text, writes what it read in both modes, and holds the extended text to read back to a canvas written to the same text. `cargo xtask inputs` holds the registry and `crates/fuzz` equal. A 60 s local run of `pnpm rust:fuzz:pr --targets json_canvas_parse` made 5.6M executions, reached 2,386 coverage points and found nothing; its six seeds (`crates/fuzz/seeds/json_canvas_parse`) are a board, one with every extension site, one with ink, one the schema refuses at every site, and one of links the core declines. |
| 15 | Logging through the `log` facade; `thiserror` convention; poison-and-recover covers held state | n/a | The crate does not log. It answers a refusal or a decline as a value, and holds no state across calls. |
| 16 | `PORTED_FUNCTIONS` ledger lists the function; once `rust`, the TypeScript export re-exports the shim | not yet | An entry needs a `CoreImpl` key to point at, which the switch adds. |
| 17 | Any Unicode table comes from a pinned crate with a version-asserting test | met (no table) | The codec carries none: it uses `is_js_space` (`whiteboard-model`, checked against the engine by the OKF checklist's row 17) and declines the hosts that need UTS 46 (below). |
| 18 | Exit criteria (QR-33b) recorded in the PR | met | [Below](#qr-33b-exit-criteria). |
| 19 | Docs reflect the shipped state | met | ADR-0054 carries a dated note for the port, saying that nothing reaches it yet. |

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
TypeScript; the replay counts each and checks the input is one the core says it
declines.

| Decline | Input | Why |
|---|---|---|
| `LoneSurrogate` | a `\uD800`-class escape not joined to its pair | a Rust `String` cannot hold it; `JSON.parse` keeps it |
| `TooDeep` | nesting past 64 on the way in, 128 on the way out | the reader recurses |
| `TooLarge` | a text over 4 MiB | the cap in `input-caps.json` |
| `Url` | a link whose host needs UTS 46 (a non-ASCII or `xn--` host), percent-decoding, an IPv6 literal, or a `file` URL | the answer needs tables this crate does not carry |
| `Unwritable` | a value kept as big-integer digits | `JSON.stringify` throws on a bigint |

In the recording, the core reads 765 of 1,400 texts to a canvas and refuses 425 at the schema, 142 as not JSON and 5 as carrying comments, which are the TypeScript's answers exactly, and declines 63: 39 for a link (`Url`), 21 for a surrogate escape and 3 for nesting. Of 600 canvases, 457 are written byte for byte, 128 are refused by the strict mode with the TypeScript's issues, and 15 are declined for a link. Every declined case is checked to be one the core says it declines: a text with a surrogate escape, a nesting past 64 or a link node.

## QR-33b exit criteria

| Criterion | Recorded |
|---|---|
| Port shape | Structure-preserving. `json_canvas/{wire,extension,schema,project}.rs` follow `json-canvas.ts`, `projection.ts` and `parse.ts`/`serialize.ts`; `json.rs`, `stringify.rs` and `url.rs` exist to keep the host behaviours the TypeScript leans on. |
| TypeScript deletion deadline | ADR-0054's default: the release after the first one that defaults to `rust`. |
| Rollback | Not yet applicable; the switch is the next increment. |
| Freeze lift | `packages/codec/src/spatial` is frozen for feature work until the switch is `rust` and the TypeScript is deleted (ADR-0054 decision 23). |
