---
paths:
  - "packages/model/**"
---

# model — whiteboard document-model Zod schemas (single source of truth)

## What belongs here

- Zod schemas: canvas meta, core/extension/raw facets, spatial canvas (JSON Canvas 1.0 + `x-whiteboard` extension), markdown body, workspace-tree node data, and the versioned mdast subset (exported via the `./mdast` subpath).
- Shared fast-check arbitraries in `src/test-utils/` (valid-by-construction; never duplicated per test file), and the
  generator they are drawn with: `arbitraryForSchema`, the zod-v4-to-fast-check walk (see "Generators" below).

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
- **Geometry is a REAL number, and the format's integer pixels are the projection's**
  ([ADR-0037](../../docs/contributing/adr/0037-model-and-format.md) slice 4).
  `nodePositionSchema` / `nodeSizeSchema` are `z.number().finite()` (sizes non-negative), and
  they are EXPORTED because every payload that echoes stored geometry has to accept what the
  model stores — a read still declaring `int` does not reject an input, it makes a tool answer
  with something its own `outputSchema` refuses. Finite rather than merely numeric:
  `JSON.stringify(Infinity)` is `null` and a NaN corner is not a corner.
- **An edge carries its own `bends`** — the points the line is drawn through, in order, capped at
  64. Same slice, and the ADR's worked example of what the old binding cost: JSON Canvas has no
  waypoint, so while the model WAS the format a bend could only exist as a plugin facet
  (`visual.path/v0`, retired) drawn by a contributed router. It passes ADR-0037 decision 3's three
  answers — a person authors one by dragging a handle the core editor draws, the renderer and the
  editor both read it, and its projection is `extension`. `edgePatchFieldsSchema` derives from
  `canvasEdgeSchema`, so it reached `wb_canvas_edit`'s edge patch for free, which is the whole
  gain: a facet payload is opaque to that tool, so a model could not place a bend at all before.
- **An edge END is a node or a POINT**
  ([ADR-0037](../../docs/contributing/adr/0037-model-and-format.md) slice 3). `edgeEndpointSchema`
  is a discriminated union on `kind` — `{ kind: 'node', node, side?, end? }` or
  `{ kind: 'point', point, end? }` — in place of the format's four flat keys
  (`fromNode`/`fromSide`/`toNode`/`toSide`), which could not say "this end is a point" at all.
  A union rather than optional fields plus a refinement, and not merely for taste:
  `edgePatchFieldsSchema` IS `canvasEdgeSchema.omit({id}).partial()`, Zod v4 refuses `.partial()`
  over a refined object, so a refinement here would be paid for with a second hand-written schema
  beside this one — the exact drift this package exists to prevent.
  Read an end through the exported helpers — `endpointNode`, `endpointNodes`, `endpointIn`,
  `endpointSide`, `nodeAtEnd`, `isSelfLoop`, `nodeEndpoint` — never by hand. Every one of the ~50
  sites that used to read `edge.fromNode` wants "the node, if there is one", and a `.kind` check
  written fifty times is fifty chances for one of them to treat a free end as a dangling
  reference. Two of the helpers exist because the obvious inline form is WRONG rather than merely
  verbose: `byId.get(endpointNode(end) ?? '')` is one character from a lookup on a key that can be
  real, and `endpointNode(from) === endpointNode(to)` answers TRUE for two free ends, which is the
  opposite of a self-loop. Both were written during this slice and both were caught by reading the
  diff, not by a test.
  Its projection is `dropped`, and the WHOLE EDGE with it: JSON Canvas requires an edge to run
  between two nodes, so a point-ended edge is omitted from both export modes. It is the one row in
  the loss table whose unit is the element rather than the field.
  The generator draws roughly one end in ten free, and `test-utils/arbitraries.test.ts` is what
  makes that a fact rather than a claim — it counts what a run produced and fails on a share out
  of band, on node ends that stopped being correlated, and on a corpus with no half-free edge in
  it. Mutation-checked in both directions.
- **A schema this model repeats is NAMED in zod's global registry**, and that is a decision about
  the MCP tool table taken here because it can be taken nowhere else. `edgeEndpointSchema` carries
  `{ id: 'EdgeEndpoint' }`, which makes every JSON Schema emission put it in `$defs` once and
  `$ref` it at each use instead of inlining the whole union.
  Measured on the four sites `wb_canvas_edit` has (`from` and `to`, on `edge.add` and
  `edge.patch`): **4,579 bytes inlined against 1,786 referenced**. Inlined, the table read 40,315 —
  over ADR-0031 §5's ~40,000 — and the endpoint was 90% of the growth that put it there. The
  growth was DUPLICATION rather than expressiveness, which is the one kind a schema can give back
  without giving anything up: `parameters` and `undescribed` both fall BELOW main's on a strictly
  richer schema, because a subschema walked four times is now walked once.
  **The registry is the only lever.** The MCP SDK converts by calling
  `schema['~standard'].jsonSchema.input({ target })` and passes no `reused` option, so
  `z.toJSONSchema(..., { reused: 'ref' })` never reaches a published schema. The SDK's own escape
  hatch, `fromJsonSchema`, swaps zod validation for ajv — which would cost the by-name refusals the
  tool-surface scoreboard pins, and this package's whole reason for existing. Rejected on that,
  not on effort.
  What it buys has to stay READABLE on its own: a `$ref` whose `$defs` entry is missing breaks no
  test here, because the server validates with zod and never reads its own JSON Schema.
  `mcp-server`'s `schema-references.test.ts` is what looks — no dangling or non-local reference
  anywhere in the table, and the endpoint resolving to the union it names rather than merely to
  something.
- **An EDGE is a RELATION and a LINE is INK**
  ([ADR-0038](../../docs/contributing/adr/0038-ocif-projection.md) decision 2). `canvasEdgeSchema`'s
  ends are `edgeEndSchema` — `{ node, side?, end? }`, a plain object with no `kind`, because a
  one-armed union discriminates nothing and would cost a key on every stored end. The
  node-or-point union is `lineEndSchema`, on `canvasLineSchema`, and `canvas.lines` is where ink
  lives. A line may join two nodes: that is the expressiveness the split buys, and where freehand
  lands rather than growing a third concept.
  - **Two collections rather than one `kind`-tagged element, and the reason is measured.** zod v4's
    `discriminatedUnion` has no `.omit()` or `.partial()` AT ALL (probed), so a tagged element would
    force `edgePatchFieldsSchema` to be hand-written beside `canvasEdgeSchema` — the exact drift
    this package exists to prevent. `linePatchFieldsSchema` is derived the same way the edge one is.
  - **`lines` is OPTIONAL, not `.default([])`.** The default makes the field required on the OUTPUT
    type, and this repo builds 925 canvas literals across 295 files; every one would have gained a
    `lines: []` saying nothing, and a diff a reviewer cannot read is a diff nobody reviews. Readers
    spell `canvas.lines ?? []`, as they already do for `comments`.
  - **Both end schemas are REGISTERED** (`EdgeEnd`, `LineEnd`), and the edge one had to be. Measured
    when the split landed: leaving `edgeEndSchema` unregistered took the visible tool table
    37,796 -> 38,317 bytes and `parameters` 273 -> 285 — a regression on a strictly simpler schema,
    because the union it replaced had been carrying a `$defs` entry and a plain object does not.
    Registered, the table came in at 36,945, BELOW where it started. The saving belongs to the
    repetition, not to the shape.
  - Ids are unique ACROSS both collections, not per collection: an anchor names an element id (a
    comment's `targetEdgeId`, a proposal's change), so two elements answering to one id makes an
    anchor ambiguous rather than merely untidy.
  - Read either kind of end through `endNode` / `endNodes` / `endIn` / `endSide` / `nodeAtEnd` /
    `isSelfLoop`, which all take `LineEnd | EdgeEnd` — a reader walking both collections should
    never have to know which it is holding.
- **This package no longer spells `x-whiteboard` anywhere.** ADR-0037 moved the interchange
  format into `packages/codec` (`spatial/json-canvas.ts`), and what used to ride inside the
  format's extension key is three ordinary fields:
  - `comments` and `facets` on the canvas,
  - `embed` and `facets` on a node — INDEPENDENT fields, where the format makes them two arms of
    one union; a node carrying both was spelled as the embed arm with facets inside it, and
    every writer that wanted to change one had to preserve the other by hand,
  - `facets` on an edge (ADR-0013 decision 5's edge slot). `edgePatchFieldsSchema` is DERIVED
    from `canvasEdgeSchema`, so the field reaches `edge.patch` for free — and reaching the
    proposal diff for free is what exposed its identity comparison (`Object.is` on two deep-equal
    objects from two different parses); that diff now compares structurally.
- **The node, edge and canvas schemas are `.strict()`, and the WIRE schemas in codec are not.**
  The asymmetry is the whole point. A JSON Canvas document another tool wrote may legitimately
  carry vendor keys, so refusing it would be wrong; this is the INTERNAL model, where a key it
  does not name is a defect. A plain `z.object` STRIPS an unknown key and returns success, which
  during ADR-0037's migration would have meant every reader still spelling the old key parsing
  cleanly and losing what it read. Measured: without the storage lift that goes with it, a node
  written under the old key does not lose a field — it VANISHES, because `readSpatialCanvas`
  drops what fails to parse (`loro-adapter`'s `legacy-extension.test.ts`).
- Strictness has one cost worth knowing: a schema error names the KEY and not the node's type,
  so a caller told only that `label` is invalid is left guessing which of its nodes was wrong.
  `canvas-edit`'s patch path therefore uses strictness as the DETECTOR and still writes the
  message itself.
- A preference meant to be overridable at a finer scope (an edge overriding the canvas's routing style) declares its vocabulary ONCE — `edgeRoutingStyleSchema` / `lineJumpsSchema`, with `edgeRoutingSchema` as the RESOLVED shape a resolver hands the layout — and the override reuses it rather than restating the shape. The stored shape is always the facet.
- The extension contract — `x-whiteboard` is the ONLY non-standard key an emitted document may
  carry — is now `packages/codec`'s to keep, along with the generated
  `docs/reference/x-whiteboard.schema.json`. See `.claude/rules/package-codec.md`.

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
- **The proposal layer (`proposal.ts`, ADR-0029) is the annotation layer's
  shape carrying a change instead of a message.** A proposed change is
  anchored to IDENTITY — an element id, or the `text` arm of
  `annotationAnchorSchema` for a passage — because a proposal has to follow
  the document as it moves, and a frontier does not. Each change carries its
  own id and `status`: the DECISION is per change, so the batch has none, and
  a status on both would leave "which one counts?" unanswerable the way
  `resolved` on a message beside its thread would. `assumed` is the anchor's
  prior value and does two jobs with one field — what to strike through, and
  what to compare a conflict against — so a prior may OMIT a field the change
  sets (the anchor held nothing there) and may never name one it does not
  (that would fire the conflict check on somebody else's unrelated edit). The
  union is closed, and `PROPOSED_CHANGE_OPS` is read off the schema, so a new
  verb cannot arrive without someone deciding what its prior value is.
  `nodePatchFieldsSchema` / `edgePatchFieldsSchema` live here rather than in
  `server-core`'s `wb_canvas_edit` for the reason everything else here does:
  a proposal STORES a patch, so it is a persisted document-model shape and a
  second declaration beside the tool's would be the drift this package exists
  to prevent.

- A key joins `RESERVED_ROOT_KEYS` the moment something INTERPRETS it, and not before. Until then
  `facetsRaw` is the right home: preserved verbatim, never half-understood.

## Generators

- **`test-utils/zod-arbitrary.ts` derives a fast-check arbitrary from a zod
  v4 schema**, and `test-utils/arbitraries.ts` is `arbitraryForSchema` over
  each model schema plus what a schema cannot say: the correlations (an
  edge's endpoints name nodes that exist, ids unique across a collection),
  the value domains a filter would waste every draw on (a facet key's
  grammar, a yaml-safe facet value), and one adversarial weighting
  (`workspaceSegmentArbitrary`). It lives here rather than in facet-engine,
  where it started, because model is the lowest package and already the
  home of the shared generators — codec, loro-adapter, canvas-viewer,
  server-core and facet-engine all reach it through a dependency they have.
  The file used to be a hand-written mirror, and it had drifted: no
  `subpath`, `label`, `versionRef`, no edge side, end or label, and nothing
  at the canvas level but comments — so every round-trip property over a
  canvas was blind to `edgeRouting` and the canvas's own facets.
- The walk's disciplines, each pinned in `zod-arbitrary.test.ts`: every
  draw is filtered through the schema, at the schema that DECLARES a
  refinement rather than only at the root (filtering at the root alone let
  a three-arm anchor union draw its refinement-free arm 645 times in 1000);
  an optional key is drawn absent half the time and never as a key holding
  `undefined`; what comes out is the schema's OUTPUT (defaults filled,
  transforms applied); a `z.lazy` nests up to `maxDepth` and then only the
  arms and empty arrays that need no expansion; a construct with no
  generator throws naming the path; a filter nothing passes throws at
  construction, from a seeded preflight, so the decision is the same on
  every run. An unbounded string runs up to twelve characters past its
  minimum, printable ASCII six draws in nine and whole graphemes two, so a
  serializer meets two of its own delimiters in one value — measured
  before: half of every string was one of four fixed clusters and none was
  longer than four characters.
- **Density is measured, not assumed.** What the canvas generator reaches
  per 1000 draws (2026-09-10): zero to six nodes at an even spread, zero
  to five edges, every node type at a quarter each, an optional node field
  present about half the time it can be, an edge's sides/ends/colour/label
  each at half, a self-loop on one edge in seven (endpoints are drawn as a
  distinct pair seven times in eight — two independent draws over four ids
  made two edges in five a loop), `x-whiteboard` on 84% of canvases with
  `edgeRouting` on 40% and canvas facets on 41%, comments on 32%; the
  anchor union at a third per arm with every reference reached. mdast text
  values (`markdownTextArbitrary`, on every `value`/`alt`/`title`/`label`
  /`identifier`/`lang`/`meta`) carry a space in 40%, markdown punctuation in
  45%, a line ending in 6% and a character outside ASCII in 15%. Eight
  mutation checks — dropping an edge label, a canvas facet, a routing
  field, a group background in codec's serializer; the same four fields
  plus the envelope in loro-adapter's bridge — each turned the round-trip
  property red. Re-measure with a scratch `fc.sample` tally when a
  generator or a schema changes shape; a property that draws a field it
  never lands is the vacuity this file exists to close.
- Its first catch, the day the model generators were derived: a canvas
  comment naming both `targetNodeId` and `targetEdgeId` was accepted by
  `canvasCommentSchema`, written, and dropped by every reader — the thread
  it becomes carries both onto one spatial anchor, which
  `annotationAnchorSchema` refuses. The schema now refines (and
  `canvasCommentDraftSchema` beside it, since zod refuses `.partial()` over
  a refined object), and loro-adapter refuses the write loudly.

## Tests

- Vitest project: `model-node` (registered in root `vitest.config.ts`).
- Every schema has accept + reject example tests; cross-schema invariants live in `src/properties.test.ts` (fast-check).
- New invariants start with a red test (repo TDD rule). Never pin a fast-check seed.

## Common mistakes (append as review finds them)

- Adding a hand-written interface next to a schema instead of `z.infer` — this is the exact drift class the package exists to prevent.
- Validating extension-facet keys leniently (silent drop). The contract is reject-not-drop.
