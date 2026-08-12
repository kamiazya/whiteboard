---
paths:
  - "packages/canvas-model/**"
---

# canvas-model — OpenCanvas data-model Zod schemas (single source of truth)

## What belongs here

- Zod schemas: canvas meta, core/extension/raw facets, spatial canvas (JSON Canvas 1.0 + `x-whiteboard` extension), markdown body, workspace-tree node data, and the versioned mdast subset (exported via the `./mdast` subpath).
- Shared fast-check arbitraries in `src/test-utils/` (valid-by-construction; never duplicated per test file).

## What does NOT belong here

- File parsing/serialization (goes to `canvas-codec`, planned), Loro containers, storage, rendering, HTTP/MCP surfaces.
- Any runtime behavior beyond schema validation.

## Dependency rules

- Only runtime dependency: `zod` (via `catalog:`). Forbidden imports: `node:*`, DOM globals, `inversify`, `loro-crdt`, remark packages.

## Conventions

- Every exported type is `z.infer`-derived. Sole exception: mutually-recursive mdast category types use the documented explicit `z.ZodType<T>` annotation, guarded by a compile-time assignability test.
- Facet buckets are disjoint by construction: extension facets live only under the reserved `facets` key (`{domain}/{version}` keys; malformed keys are rejected, not dropped). Unknown ROOT-level frontmatter keys belong to `facetsRaw`, never to extension facets.
- mdast schemas follow the mdast spec content-model hierarchy (flow / phrasing / list / table / row content). Do not widen a parent's `children` back to the flat node union.
- IDs: canvas ID = canonical ULID (first char `[0-7]`); node ID = nanoid (charset deliberately unenforced — documented looseness).
- JSON Canvas geometry is integer, with no extension carve-out: `x-whiteboard` carries no geometry of its own.
- There are two `x-whiteboard` keys, and the line between them is what keeps the node-level one from growing back:
  - **On a NODE** it is the canvas-embed extension only — CONTENT that JSON Canvas cannot express. Do NOT grow it into a general home for visual primitives JSON Canvas lacks (the `freehand`/`shape` variants were removed for exactly that reason); express those through an existing node type instead.
  - **On the CANVAS** it holds rendering PREFERENCES for things JSON Canvas already models (today: `edgeRouting.style`). A consumer that drops it still renders every edge, just with its own routing. Nothing that changes what the document MEANS belongs here.
- Both are the documented exception to the reject-not-drop rule above — an unrecognised payload is silently dropped (`.catch(undefined)`) so a document written by another version still parses. The reject-not-drop contract governs what others must honour; these keys are our own escape hatch, and the document survives either way.
- A preference meant to be overridable at a finer scope later (an edge overriding the canvas's routing style) declares its schema ONCE — `edgeRoutingSchema` — and the override reuses it rather than restating the shape.
- **`x-whiteboard` is the ONLY extension key** an emitted document may carry — never add a second non-standard field at any level. The contract is published as a generated JSON Schema (`json-schema.ts` → `docs/reference/x-whiteboard.schema.json`, a vitest file snapshot held in sync by `json-schema.test.ts`; regenerate with `pnpm vitest run --project canvas-model-node json-schema -u`) and enforced by canvas-codec's `extension-contract.property.test.ts` (foreign keys stripped on parse, emission stays within JSON Canvas 1.0 + `x-whiteboard`). Extending what lives INSIDE `x-whiteboard` means regenerating the artifact in the same increment.

## Tests

- Vitest project: `canvas-model-node` (registered in root `vitest.config.ts`).
- Every schema has accept + reject example tests; cross-schema invariants live in `src/properties.test.ts` (fast-check).
- New invariants start with a red test (repo TDD rule). Never pin a fast-check seed.

## Common mistakes (append as review finds them)

- Adding a hand-written interface next to a schema instead of `z.infer` — this is the exact drift class the package exists to prevent.
- Validating extension-facet keys leniently (silent drop). The contract is reject-not-drop.
