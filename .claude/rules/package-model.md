---
paths:
  - "packages/model/**"
---

# model — whiteboard document-model Zod schemas (single source of truth)

## What belongs here

- Zod schemas: canvas meta, core/extension/raw facets, spatial canvas (JSON Canvas 1.0 + `x-whiteboard` extension), markdown body, workspace-tree node data, and the versioned mdast subset (exported via the `./mdast` subpath).
- Shared fast-check arbitraries in `src/test-utils/` (valid-by-construction; never duplicated per test file).

## What does NOT belong here

- File parsing/serialization (goes to `codec`, planned), Loro containers, storage, rendering, HTTP/MCP surfaces.
- Any runtime behavior beyond schema validation.

## Dependency rules

- Only runtime dependency: `zod` (via `catalog:`). Forbidden imports: `node:*`, DOM globals, `inversify`, `loro-crdt`, remark packages.

## Conventions

- Every exported type is `z.infer`-derived. Sole exception: mutually-recursive mdast category types use the documented explicit `z.ZodType<T>` annotation, guarded by a compile-time assignability test.
- Facet buckets are disjoint by construction: extension facets live only under the reserved `facets` key (`{namespace}.{name}/v{n}` keys per ADR-0013; malformed keys are rejected, not dropped). Unknown ROOT-level frontmatter keys belong to `facetsRaw`, never to extension facets.
- mdast schemas follow the mdast spec content-model hierarchy (flow / phrasing / list / table / row content). Do not widen a parent's `children` back to the flat node union.
- IDs: document ID = canonical ULID (first char `[0-7]`); node ID = nanoid (charset deliberately unenforced — documented looseness).
- Workspace identity (ADR-0019) is three layers, not one: canonical workspace ID = a bare ULID, the same canonical-ULID shape as document ID (no `ws_` prefix — symmetric with `documentIdSchema`, distinct Zod schemas are the confusion guard); segment = the URL-safe, per-keeper-unique, renameable handle, which must NOT itself be ULID-shaped (a 26-char Crockford base32 string with a leading `[0-7]`, checked case-insensitively) because workspace URLs resolve segment-first with canonical-id fallback in one position; displayName = free text, no uniqueness, no identity duties. `workspaceIdSchema` (the pre-ADR-0019 single-string shape) is untouched — it describes the legacy live data both keepers still hold, and re-keying onto the three-layer shape is a later migration-driven slice.
- JSON Canvas geometry is integer, with no extension carve-out: `x-whiteboard` carries no geometry of its own.
- There are two `x-whiteboard` keys, and the line between them is what keeps the node-level one from growing back:
  - **On a NODE** it is the canvas-embed extension only — CONTENT that JSON Canvas cannot express. Do NOT grow it into a general home for visual primitives JSON Canvas lacks (the `freehand`/`shape` variants were removed for exactly that reason); express those through an existing node type instead.
  - **On the CANVAS** it holds rendering PREFERENCES for things JSON Canvas already models (today: `edgeRouting.style`). A consumer that drops it still renders every edge, just with its own routing. Nothing that changes what the document MEANS belongs here.
- Both are the documented exception to the reject-not-drop rule above — an unrecognised payload is silently dropped (`.catch(undefined)`) so a document written by another version still parses. The reject-not-drop contract governs what others must honour; these keys are our own escape hatch, and the document survives either way.
- A preference meant to be overridable at a finer scope later (an edge overriding the canvas's routing style) declares its schema ONCE — `edgeRoutingSchema` — and the override reuses it rather than restating the shape.
- **`x-whiteboard` is the ONLY extension key** an emitted document may carry — never add a second non-standard field at any level. The contract is published as a generated JSON Schema (`json-schema.ts` → `docs/reference/x-whiteboard.schema.json`, a vitest file snapshot held in sync by `json-schema.test.ts`; regenerate with `pnpm vitest run --project model-node json-schema -u`) and enforced by codec's `extension-contract.property.test.ts` (foreign keys stripped on parse, emission stays within JSON Canvas 1.0 + `x-whiteboard`). Extending what lives INSIDE `x-whiteboard` means regenerating the artifact in the same increment.

- **OKF's own vocabulary is modelled in `trust.ts`**, and it is deliberately looser than the spec's
  prose reads. `okfActorSchema` validates a non-blank single-line string, NOT §7's three bullets —
  the list is not exhaustive and §5.1's own example writes `author: team:ga4-docs`, so enforcing the
  bullets would reject the specification's own sample data. The one shape that carries meaning is
  the `human:` prefix (§5.3 keys trust tiers off it), and `isHumanActor` is the single place that
  check lives. `trustTier` is DERIVED on read and never stored — OKF's whole position is that a
  stored verdict is subjective, unportable and goes stale.
- **The annotation layer (`annotation.ts`, ADR-0026) is format-agnostic except
  for its anchor.** A thread carries where it points, whether it is open, and
  its messages; only `annotationAnchorSchema` varies by document kind, and it
  is a CLOSED discriminated union so every renderer's switch over it stays
  exhaustive. Every arm has the same shape — an optional object reference plus
  a positional fallback — because the reference is what survives the object
  moving and the position is what survives it being deleted. The arm is the
  SURFACE and the reference names an object on it: the spatial arm names a
  node or an edge, the text arm names the node whose text holds the passage
  (absent, a note's own body). Supporting a new document format means adding
  an arm here; a new object on an existing surface is a new reference on
  that surface's arm, never a new arm. `ANNOTATION_ANCHOR_KINDS` is read off
  the schema, and `annotation.test.ts` checks the generator draws every arm
  and every reference, so neither can be added without the other.
- A key joins `RESERVED_ROOT_KEYS` the moment something INTERPRETS it, and not before. Until then
  `facetsRaw` is the right home: preserved verbatim, never half-understood.

## Tests

- Vitest project: `model-node` (registered in root `vitest.config.ts`).
- Every schema has accept + reject example tests; cross-schema invariants live in `src/properties.test.ts` (fast-check).
- New invariants start with a red test (repo TDD rule). Never pin a fast-check seed.

## Common mistakes (append as review finds them)

- Adding a hand-written interface next to a schema instead of `z.infer` — this is the exact drift class the package exists to prevent.
- Validating extension-facet keys leniently (silent drop). The contract is reject-not-drop.
