# Parity checklist: the facet engine's write path

The [QR-33a](../quality-requirements.md) checklist for the fourth ported
module, filled in as far as this slice goes: **the Rust facet registry and the
runtime interpreter of the contract dialect** (`crates/core/facet-engine`, step 6
of [ADR-0054](../adr/0054-rust-core.md), slice S6). The TypeScript it is held to
is `validateFacetWrite`, `targetsOf` and `assetRefsOf` in
`packages/facet-engine/src/registry.ts`, with each facet's generated Zod schema
as the oracle. **S8 adds the wasm export (`facet_bucket_check`, below), its
shim, and the switch the daemon dispatches through (stage 2, `differential`;
the default is `rust`, with the TypeScript kept as the `ts` rollback until its
deletion).** `PORTED_FUNCTIONS` lists `partitionFacetWrites` at stage 2, which
stays until the TypeScript is deleted.

## What shipped

- `whiteboard_facet_engine::schema`: a contract file's `$defs` compile into
  nodes (`Contracts::load`), and `Contracts::validate` judges a `Value` against
  one. A plugin's payload schemas are the contract files it ships, so a plugin
  that is not built into the binary is judged by the same walk as one that is
  (owner decision q41). The host supplies, by the name the contract gives them,
  the matchers of its patterns, the named checks and the `x-wb-external`
  definitions (`Host`); a contract that names one the host does not supply is
  refused at load.
- `whiteboard_facet_engine::registry`: `Registry::build` over plugin manifests,
  `targets_of`, `asset_refs_of` and `validate_facet_write`.
- Two recorded oracles, each replayed natively and on wasm32:
  `packages/facet-engine/src/oracle/contract-schemas.jsonl` (819 cases through
  the engine contract's theme, icon and stencil schemas and the plugin manifest:
  numbers and bounds, defaults, a union of definitions, a union chosen by a
  property) and `packages/plugin-visual/src/oracle/facet-write.jsonl` (2,768
  lines: the bundled registry's declarations and writes, about 120 accepted and
  120 broken payloads per facet, plus hand-written cases for the bounds, the
  grammars and the key, version and asset stages). Each is regenerated with
  `WHITEBOARD_RECORD_ORACLE=1` and held to today's TypeScript by a test that
  asks every recorded question again.
- Properties over the same corpus (`tests/schema_properties.rs`), and a drift
  test (`crates/core/plugin-visual/tests/contract_drift.rs`) that compiles every
  contract file the repository ships.

## What S7 added: a plugin loaded from its files

- The bundled plugin's asset tables are JSON files under
  `packages/plugin-visual/src/assets/` (owner decision q45), read by the
  TypeScript through `asset-table.ts` and embedded by the Rust core. They are
  the single source; neither side holds a copy.
- `whiteboard_model::json` (moved from `whiteboard-codec`, which re-imports it)
  reads JSON text in written key order, which `serde_json` does not.
- `whiteboard_facet_engine::{plugin, manifest}`: `engine_contracts()` and
  `ENGINE_HOST`, `manifest::read`, and `plugin::build` over a `PluginSources`
  (manifest, contracts and tables as text): the contracts compile, the manifest
  is judged and decoded, every asset entry is judged by the engine's shape for
  its kind under its `<plugin>.<name>` id, the registry is built, and every
  facet payload a bundled stencil carries is checked against the facet it names
  (what `assertStencilPayloadsValid` does). Each `LoadError` has a test.
- `whiteboard_plugin_visual::host`: `VISUAL_HOST` (the matchers, checks and
  externals the visual contract leaves to a host), `registry_from` and
  `visual_registry()`. The oracle replay judges that registry and asserts its
  registered asset ids equal the recorded header's, so the order of the files is
  held by the TypeScript's own answers.
- Not here yet: compat (`resolve_facet_payload`), the editor's derived form
  (`manifest::read` leaves `editor` and `compat` as `None`), more than one
  plugin, a workspace's own stencil library, the specimen-icon check, and the
  wasm export, the switch, `PORTED_FUNCTIONS`, the input caps and the fuzz
  target (S8; the library, the export, the caps, the fuzz target and the cache
  of `visual_registry()` are below, the switch and `PORTED_FUNCTIONS` follow).

## What S8 added: the facet write behind one export

`facet_bucket_check(target, bucket, library) -> String` in
`crates/bindings/wasm/src/facet_write.rs` is the server's `partitionFacetWrites`
and `refuseUnusableStencilLibrary` in one call. The logic is
`whiteboard_facet_engine::partition` (the bucket key by key in its order: the
facet's targets, `validate_facet_write_with`, then `first_unrecognized_key`;
the first refusal wins) and `Registry::judge_workspace_stencil` /
`compose_library` (each library stencil judged alone: name, the engine's
shape, each facet payload; the refused ones dropped); the export is the wire,
the caps and a `visual_registry()` built once behind a `OnceLock`.

- **Inputs.** The target, the bucket and the workspace's stored library as the
  value wire of `okf_wire.rs` (every number as its 64 bits, one array per
  collection, a mapping in the order the host enumerates it). The library is
  registered for the call as `workspace.<name>` ids after the registry's own.
- **Answer.** `["ok", sets, deletions]`; `["refused", key, stage, ...]` with the
  stage `target`, `malformed-key`, `not-current`, `invalid` (issues as
  `[path, code, detail]`, a union's arms and a record key's issues nested),
  `unregistered-asset`, `unrecognized-key` or `library` (each stencil the
  registry would drop, with why); or `["declined", code, class]` past a cap,
  which a root answers from the TypeScript. The sentence is the root's to word
  (q43, above).
- **Held to the TypeScript** by `packages/server-core/src/tools/facet-write.core.test.ts`,
  which runs `partitionFacetWrites` and `refuseUnusableStencilLibrary` beside
  the shim over hand-written payloads at every target and over seven stored
  libraries, a valid, a broken and a stripped payload for every registered facet
  and generated buckets: the key, the stage, the path and code of every issue in
  order, the dropped stencils, and the sets bit for bit in their key order; and by
  `crates/bindings/wasm/tests/facet_write_oracle.rs`, which replays the 2,768
  recorded writes through the export. Both reach every stage.
- **What the TypeScript does that the Rust must copy.** A key spelt like an
  `Object.prototype` member is never reported as stripped, because the walk asks
  `key in parsed`; the walk finds the first stray key in the sender's order, a list
  index at a time; the library the bucket writes is judged only after every key has
  passed; and a payload holding `__proto__` stops the walk at its key, which the
  shim does (the core never sees one). A null payload is a deletion and is judged by
  nothing.
- **Declines, not deviations.** A value the wire cannot carry is declined, and the
  root answers it from the TypeScript: an `undefined` where the TypeScript reads an
  absent key (it would accept `{ kind: 'ellipse', extra: undefined }`), a lone
  surrogate, a value past the caps. The shim's tests pin the first against what
  `firstUnrecognizedKey` answers for it.
- **Caps** (`crates/input-caps.json`): 8 MiB of the two texts together, 131,072
  values, 64 levels, 3,000 ms; the reasons carry the measurements. The values cap
  exists because the cost of a refusal is superlinear in the values refused, which a
  byte cap does not bound: 4.2 MB of invalid tag keys took 4.7 s, 8 MB took 15.7 s.
  The fuzz target `facet_wasm_bucket_check` holds the stored and deleted keys to the
  bucket's own and a refusal to a key the bucket holds, with 81 seeds taken from the
  recording.
- **Size.** The unstripped artifact grew from 1,096,529 to 1,363,305 bytes and the
  shipped, stripped module from 632,603 to 835,344: the interpreter, the loader and
  the registry, the visual plugin's checks, and 73 KB of the plugin's own files
  embedded. The ledger's ceiling is raised by hand with that reason.

## What S8 added: the switch

`WHITEBOARD_CORE_FACETS` (`ts`, `differential`, `rust`; default `rust`) reaches
every write of a facets bucket: `wb_facet_set`, `wb_canvas_edit`'s `facets`, a
document's frontmatter facets and the stencil library a write carries. The
dispatcher is `facetWriterFor(...).write` in server-core
(`packages/server-core/src/tools/facet-write.ts`), over `ServerDeps.facetWriteCore`, a lazy factory the
daemon fills from the one wasm instance the other switches share.

- **`ts`** runs `partitionFacetWrites` and `refuseUnusableStencilLibrary`.
- **`rust`** answers with `facetBucketCheck` and throws the class the
  TypeScript throws (`ReservedKeyWriteError` for a `__proto__` key,
  `FacetWriteRejectedError` for every other stage), so the `REFUSALS` rows do not
  move. The sentence is rebuilt from the stage; a schema refusal names places and
  codes, not Zod's words (q43).
- **`differential`** runs both, answers with the TypeScript and reports a
  difference through `WHITEBOARD_CORE_MISMATCH` (`log`, or `throw` in CI). A
  difference is a different stage, key, or issue path and code in order (with a
  union's arms, a record key's issues and an object's unrecognised keys), a
  different stage detail (targets, current key, asset field, id and kind,
  registered ids, stray path and key, dropped stencil names), or sets that are
  not equal bit for bit with their key order, or different deletions. Messages
  are excluded. The TypeScript's side is compared as data: the registry's
  `validateFacetWrite` now answers its stage beside its message.
- **A decline** (`CoreInputRefused`, or any throw from the call) is answered by
  the TypeScript in every mode and reported as `facets-declined`.
- **The library** is sent only with a write whose bucket holds a facet that takes
  a stencil; every other write still lists the workspace zero times.
- **Boot.** Under `differential` or `rust` (the default) the daemon refuses to
  start unless its plugins are `['visual']`, the registry the core holds; a
  deployment composing another set sets `ts`.
- **CI.** The mcp-node and test-shared (server-core-node) steps, the e2e and
  mcp-smoke steps and both packaged smokes run `differential` with mismatches
  throwing; the dev scripts default to `differential`. The whole server-core and
  daemon suites, the tool-input fuzz included, ran with no difference reported.

## Declared deviation (owner decision q43)

A refusal matches the generated Zod's issues **in path and code, in order**.
The message may differ, and is not compared, recorded or carried except where
the contract wrote a sentence (a pattern's `x-wb-message`, a list's
`x-wb-maxItemsMessage`, a record's `x-wb-maxPropertiesMessage`), which an issue
holds as `Detail::Message`. A union's issues also match one level down: each
arm's issues, and the issues a record's key was refused with.

## What the oracle found that the plan did not say

Each of these was found by a recorded case the first draft got wrong, and each
now has a unit test.

| Zod 4.6.7 behaviour | What the interpreter does |
|---|---|
| A list past its `maxItems` is refused by that bound alone, before any element is judged (`capSize`), and the issue does not `continue` | One `too_big` with `continue = false` and no element issue, however bad the elements are |
| The length checks (`min`/`max`) have a `when` that runs them on **any** value that has a `length`, even one whose type check just refused it | A list given to a string schema also gets `too_small`; a string given to a list schema gets `too_small` or `too_big` by its length; an object whose own `length` is a number is measured by it |
| A string's `min` is counted in code points when the UTF-16 count is within `[min, 2*min)`, and in UTF-16 units otherwise, which always agrees with counting code points | Counted in code points. That differs from the word `Utf16` in `x-wb-minUtf16` only for an astral character under a bound of 2 or more; every contract's bound is 1 |
| A required field that is absent is judged as `undefined`: a union gives `invalid_union` with every arm, a plain type `invalid_type`, and an any-value passes, which then yields `invalid_type` | Mirrored |
| A union with exactly one non-aborted failing arm speaks with that arm's issues (`visual.symbol` with an emoji of the wrong grapheme count) | Mirrored; a tagged union (`oneOf` with a `discriminator`) judges the arm its tag names and otherwise gives one `invalid_union` with no arms at the tag's path |
| A `.default()` is not judged: an absent property reads as the default as written | Mirrored (`{}` or `[]`) |
| `z.strictObject` names its unknown keys after the fields' own issues, `__proto__` included; a stripping object drops them | Mirrored |
| `CanvasColor` (an `x-wb-external` of the model) is a union of a preset enum and a hex pattern, so `"red"` is `invalid_format` alone and `5` is `invalid_union` with both arms | The host's validator says so (`External::Validator`); the oracle test's validator is that union |
| `targetsOf` and `assetRefsOf` look the facet up by namespace and name, **not** version | Mirrored: `visual.shape/v9` answers `visual.shape`'s targets |

## Not mirrored, and said so

- An object whose `length` is not a number is treated as having no length.
  Zod runs its length checks on it and compares as JavaScript would.
- The model's own contracts (`okf`, `spatial`) are refused at load by the
  constructs only the model port implements: integers, `x-wb-lenient`, `keep`,
  `x-wb-extends`, and a named check on an object or a record. Nothing silently
  skips one (`contract_drift.rs`).
- Not ported: read-side compat resolution (`resolveFacetPayload`), the derived
  editor form (`facetForm`), the definition-time checks of `defineFacet` and
  `definePlugin` beyond the asset shapes, and the registry build's check on a
  picker's specimen icon. `Registry::build`
  takes the ids a host holds per asset kind and checks a manifest's own
  consistency: a duplicate or reserved plugin id (`workspace`), a duplicate facet
  name, a schema pointer no contract holds, and an `assetRefs` field the payload
  schema does not declare.
- The interpreter takes input in JavaScript's enumeration order (integer-like
  keys first), which the caller applies with `whiteboard_model::enumeration_order`;
  the recording is in that order. The value it answers has an object's keys in
  the schema's order and a record's in the input's.
- `Registry::build` takes the compiled `Contracts` (the `Host` is used where they
  are loaded), and an alias `$ref` cycle is refused at load, so no depth cap is
  needed: the recursion is bounded by the number of definitions.
- An absent value handed to an `x-wb-external` validator is `invalid_type`:
  the validator judges only what is there.

## QR-33a

| # | Check | Status | Evidence, or what is missing |
|---|---|---|---|
| 1 | Contracts in `contracts/`, generated, `codegen --check` clean | met | The interpreter reads the contract files themselves; `codegen --check` is clean |
| 2 | Layer per the architecture map; no third-party dependency | met | `whiteboard-facet-engine` depends on `whiteboard-model` alone; dev: `serde_json`, the proptest prelude |
| 3 | Clippy, fmt, no new `#[expect]` | met | None added |
| 4 | Properties through the prelude, floors, mutation-checked | met | `tests/schema_properties.rs`: totality and paths into the input, a fixed point on accept, an unknown key stripped or named; each has a reachability floor |
| 5 | Port conformance suites | n/a | A pure function of a payload |
| 6 | Layer 1: TypeScript tests against Rust | met | `facet-write.core.test.ts` runs the TypeScript write path beside the export, and the server-core and mcp-node suites run every facet write in `differential` with mismatches throwing (CI), reporting none |
| 7 | Layer 2: property differential | met | `facet-write.core.test.ts`: generated buckets and a payload per registered facet, valid, broken and stripped, through the shim against `partitionFacetWrites`, every stage reached; the recorded oracles hold the registry below it |
| 8 | Layer 3: byte-identical on wasm | met | Both replays and every test run on wasm32 with the same count: 94 tests for `whiteboard-facet-engine` and 25 for `whiteboard-plugin-visual` on both targets (`cargo xtask cross-target`) |
| 9 | Tolerated differences are ledger entries | met | The message (q43), above |
| 10 | `differential` has run in CI and dogfooding | met (CI and a smoke run) | CI runs it with mismatches throwing (above) and the dev scripts default to it. `WHITEBOARD_CORE_FACETS=differential WHITEBOARD_CORE_MISMATCH=throw pnpm smoke:e2e` also ran green ("ALL OK") against a real daemon through the MCP surface: `wb_facet_set` on markdown documents, nodes, edges and the canvas (set, merge, null tombstone, refusals), `wb_canvas_edit` facet payloads, a workspace-defined stencil and tag library, and a document round trip, with zero mismatches and zero declines reported (a difference throws and fails the run). Per owner decision q18 only development data exists, so no run over a real user workspace is claimed |
| 11 | `cargo mutants` clean or ledgered; coverage at the floor | met | `cargo mutants` over `schema/*.rs` and `registry.rs`, judged by this crate's and `whiteboard-plugin-visual`'s tests: 326 mutants, 137 caught, 188 unviable and one missed (a non-empty default read as an empty one), which a test now judges; nothing is ledgered. `pnpm rust:mutants:pr`, shard 1 of 8: 41 mutants, 35 caught, 6 unviable, none missed. Coverage of `core/facet-engine` is 100.00% of lines, regions and functions against a floor of 100 and 100. The facet write (S8): `cargo mutants --in-diff` over `partition.rs` and `registry.rs` (23 mutants: 18 caught, 5 unviable) and over `facet_write.rs` (35: 32 caught, 3 unviable; the first run missed one, a mapping not counted toward the depth and values caps, which a test now judges), none missed and none ledgered. Coverage of `core/facet-engine` stays 100.00% of lines, regions and functions; `bindings/wasm` is 89.84% lines and 85.14% regions against floors raised to 88 and 84 |
| 12 | One call per user operation; boundary cost | met | A bucket and its library cross once (`facet_bucket_check`); the cost at the caps is in the entry's reason: 421 ms for the slowest draw, 88 ms for one 8 MiB string |
| 13 | Artifact size | met | The export links the interpreter, the loader, the registry and the plugin's files: 1,096,529 to 1,363,305 bytes unstripped, 632,603 to 835,344 shipped; the ceiling is raised by hand with that reason |
| 14 | Untrusted-input caps and a fuzz target | met | `whiteboard-wasm::facet_write::facet_bucket_check` in `crates/input-caps.json`, enforced by the export and by the shim before the call; fuzz target `facet_wasm_bucket_check` |
| 15 | Logging; poison-and-recover | n/a | Refusals are values; no state |
| 16 | `PORTED_FUNCTIONS` | met | `partitionFacetWrites`, stage 2: the switch in `packages/server-core/src/facet-write-core.ts`, `facet_bucket_check`, the shim's `facetBucketCheck` |
| 17 | Unicode tables | n/a | None: a string is measured in code points, with no table |
| 18 | Exit criteria | partly | The switch defaults to `rust`; `ts` and `differential` remain as the rollback and the comparison. The TypeScript's deletion, and with it stage 4, is the next PR |
| 19 | Docs reflect the shipped state | met | This file, the crate row, `package-facet-engine.md`, ADR-0054's note |
