# Parity checklist: the facet engine's write path

The [QR-33a](../quality-requirements.md) checklist for the fourth ported
module, filled in as far as this slice goes: **the Rust facet registry and the
runtime interpreter of the contract dialect** (`crates/core/facet-engine`, step 6
of [ADR-0054](../adr/0054-rust-core.md), slice S6). The TypeScript it is held to
is `validateFacetWrite`, `targetsOf` and `assetRefsOf` in
`packages/facet-engine/src/registry.ts`, with each facet's generated Zod schema
as the oracle. **There is no wasm export, no switch and no `PORTED_FUNCTIONS`
entry yet; those are S8.** A `PortedFunction` names the shim export that
re-exports or dispatches to it (`shim: { module, file, member }`) and a stage 2
differential through the wasm, and neither exists until S8 adds the export.

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
  target (S8). `visual_registry()` rebuilds on every call; S8 caches it.

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
| 6 | Layer 1: TypeScript tests against Rust | not yet | There is no export to run them against (S8) |
| 7 | Layer 2: property differential | partly | The recorded oracles replace the live differential until the export exists |
| 8 | Layer 3: byte-identical on wasm | met | Both replays and every test run on wasm32 with the same count: 61 tests for `whiteboard-facet-engine` and 21 for `whiteboard-plugin-visual` on both targets (`cargo xtask cross-target`) |
| 9 | Tolerated differences are ledger entries | met | The message (q43), above |
| 10 | `differential` has run in CI and dogfooding | not yet | S8 |
| 11 | `cargo mutants` clean or ledgered; coverage at the floor | met | `cargo mutants` over `schema/*.rs` and `registry.rs`, judged by this crate's and `whiteboard-plugin-visual`'s tests: 326 mutants, 137 caught, 188 unviable and one missed (a non-empty default read as an empty one), which a test now judges; nothing is ledgered. `pnpm rust:mutants:pr`, shard 1 of 8: 41 mutants, 35 caught, 6 unviable, none missed. Coverage of `core/facet-engine` is 100.00% of lines, regions and functions against a floor of 100 and 100 |
| 12 | One call per user operation; boundary cost | not yet | S8 |
| 13 | Artifact size | met | The wasm artifact does not change: nothing links the crate yet (`cargo xtask size` fits the same ledger) |
| 14 | Untrusted-input caps and a fuzz target | not yet | The entry is the export (S8) |
| 15 | Logging; poison-and-recover | n/a | Refusals are values; no state |
| 16 | `PORTED_FUNCTIONS` | not yet | Needs the shim export (S8) |
| 17 | Unicode tables | n/a | None: a string is measured in code points, with no table |
| 18 | Exit criteria | not yet | S8 |
| 19 | Docs reflect the shipped state | met | This file, the crate row, `package-facet-engine.md`, ADR-0054's note |
