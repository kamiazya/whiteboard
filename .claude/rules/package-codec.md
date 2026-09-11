---
paths:
  - "packages/codec/**"
  # apps/web imports this package directly and is NOT source-scanned by arch-lint, so the
  # Consumers note below is the only place that boundary is written down — it has to reach
  # whoever is editing apps/web, not just whoever is editing this package.
  - "apps/web/**"
---

# codec — OKF-Markdown / JSON Canvas serialize+parse + remark pipeline

## What belongs here

- Single-document OKF-Markdown (YAML frontmatter + markdown body) serialize/parse (`okf/`).
- Single-document JSON Canvas 1.0 (+ `x-whiteboard` extension) serialize/parse, including the
  strict-mode degradation rule (`spatial/`).
- The remark/unified markdown pipeline: `parseMarkdownBody`/`stringifyMarkdownBody` over the
  closed CommonMark + GFM + math syntax set, and `normalizeMdast` (`markdown/`).
- Pure, injected-resolver reference resolution: `resolveReferences` (import) and
  `resolveReferencesForExport` (export) (`references/`).
- `CodecParseResult<T>`/`CodecParseError` — the total-parser error contract every parser here
  returns instead of throwing (`errors.ts`).
- The JSON Canvas PROJECTION ([ADR-0033](../../docs/contributing/adr/0033-model-and-format.md)):
  the wire shape (`jsonCanvasDocumentSchema`), `toJsonCanvas`/`fromJsonCanvas`, the
  `JSON_CANVAS_PROJECTION` ledger and the `jsonCanvasLoss()` table it derives
  (`spatial/projection.ts`), plus `censusSpatialModel` — how far the format reaches into the
  model, counted from the schemas (`spatial/census.ts`).

## What does NOT belong here

- The LoroDoc<->model bridge, attachments, multi-canvas OKF bundles, or bundle manifests —
  deferred to `loro-adapter` (see architecture-map.md).
- Scene graph, layout, rendering (`canvas-render`, planned).
- Storage, HTTP/MCP surfaces, Inversify DI (composition roots only: `mcp-server`, `apps/web`).
- Any runtime behavior beyond parsing/serializing a single document.

## Dependency rules

Runtime dependencies: `@kamiazya/whiteboard-model` (workspace), `zod`, and the closed
`unified`/`remark-*`/`yaml` set (all `catalog:`). Forbidden: `node:*`, DOM globals, `inversify`,
`loro-crdt`. Enforced by `tools/arch-lint` (`arch-lint-node` vitest project) — both the banned-
construct scan and the package.json dependency-direction check run against this package's `src/`.

## Consumers

Besides `loro-adapter` and `canvas-viewer`, `apps/web` depends on this package directly (its
markdown-editor preview pane calls `parseMarkdownBody` to feed canvas-render's
`layoutMdastBlocks`/`renderSceneToSvg`, the same parse path `canvas-viewer` and `mcp-server` use
for spatial text nodes and export — kept as one renderer instead of a second markdown-to-HTML
fallback). `apps/web` is a composition root, so this is an allowed forward dependency per
`architecture-map.md`; it is not source-scanned by `tools/arch-lint` (only the reverse-direction
guard applies to composition roots), so this note is the boundary's only documentation.

The "one renderer" half of that has a second caller now, and it is worth naming because the
obvious reuse was the wrong one. A COMMENT's body is markdown too (ADR-0026's 2026-09-06
supplement), so `apps/web`'s comment card and rail draw it through canvas-render as well — but
through `layoutCommentBody`, NOT through the preview renderer. The two differ in the markdown
THEME: the preview passes `MARKDOWN_THEME_DOCUMENT` (30px h1, 16px block gap) and a comment
takes the NODE theme the canvas bubble takes (24px, 12px). Reaching for "the markdown renderer"
would have given a comment document typography and read as a design choice. There is still no
markdown-to-HTML fallback anywhere, and adding one for comments was considered and refused for
the reason above: a second renderer is how a surface comes to disagree with the export.

What that costs, recorded here rather than discovered later: a body drawn this way is `<text>`
elements, so it carries no heading or list semantics into the accessibility tree. It is the same
trade the preview pane already makes, and making a different one for comments would leave the
app with two conventions for one question. A LIST ROW is the documented exception — the rail's
row is a clamped button, so it shows a plain-text projection (`commentExcerpt`), which walks the
PARSED body rather than the laid-out one: layout puts the space between two words in an x offset
rather than in a string, so joining its runs yields `tightenthis`.

## Conventions

- Every exported type is `z.infer`-derived (`OkfMarkdownDocument`, `OkfMarkdownFrontmatter`) or
  re-exported from model — never a hand-written interface next to a schema.
- Parsers (`parseOkf`, `parseSpatial`) are total: they return `CodecParseResult<T>`, never throw a
  raw `ZodError`/`SyntaxError`, and never silently return a partial value. Every failure stage
  (`yaml` / `frontmatter-schema` / `json-syntax` / `json-canvas-schema`) has a pinned example test.
- OKF facets-domain keys are emitted in canonical lexicographic order on serialize — authoring
  order is not preserved. Facet values are validated against `yamlSafeValueSchema` before emission;
  a non-yaml-safe value (undefined/NaN/Infinity/bigint/function/symbol/cyclic) is a typed error,
  not a corrupt YAML file.
- Root frontmatter keys this codebase does not model are PRESERVED, not dropped (OKF §4.1). `parseOkf`
  routes every non-reserved root key into `facetsRaw` and `serializeOkf` spreads them back at the
  root, in the same canonical key order as `facets` — the bucket itself is never emitted as a
  `facetsRaw:` key, which OKF gives no meaning to. This is what carries OKF v0.2's `sources` /
  `generated` / `verified` / `status` / `stale_after` / computation families through a whiteboard
  read-edit-write without modelling any of them. `RESERVED_ROOT_KEYS` (model) is the single
  definition of what is not free to preserve; `facetsRaw` is deliberately absent from it, so a
  document carrying a literal root `facetsRaw:` round-trips like any other unknown key.
  A plain `z.object` parse silently strips unknown keys, so the routing step is load-bearing and
  both halves are mutation-checked by the round-trip properties in codec and server-core.
- **Never put a `transform` under `okfMarkdownFrontmatterSchema`.** It is published as
  `wb_document_get`'s `outputSchema`, which the MCP SDK converts to JSON Schema for `tools/list` —
  a transform anywhere inside fails the WHOLE listing with "Transforms cannot be represented in
  JSON Schema", and no unit test sees it. Normalise on the way in, in `parseOkf`, and let every
  published schema state the single shape it holds. OKF §5.2's bare-`verified`-mapping widening is
  the standing example (`normalizeOkfVerified` in model).
- Strict JSON Canvas degradation is ONE uniform rule: drop the entire `x-whiteboard` key from every
  node. No per-kind special casing. Extended mode is lossless over what the extension key can
  hold; GEOMETRY is the one thing it is not, because the format specifies integer pixels and the
  model does not (ADR-0033 slice 4) — the ledger's only `degraded` entry, and the reason the
  round-trip property is stated as IDEMPOTENCE (the expressible subset is the projection's image)
  with the already-integral case pinned by example in `geometry-projection.test.ts`.
- **A document becomes a JSON Canvas document in ONE place.** `serializeSpatial` and
  `parseSpatial` both go through `spatial/projection.ts`, so `JSON_CANVAS_PROJECTION` is the
  single account of what crossing costs. The projection RELOCATES rather than copies now: the
  canvas's `comments` and `facets`, a node's `embed` and `facets`, and an edge's `facets` and
  `bends` become the extension key on the way out, and the node's two independent fields fold
  back into the format's single union arm. An edge's extension is therefore its OWN declaration
  (`edgeExtensionSchema`) rather than the node's facets-only arm: since ADR-0033 slice 4 an edge
  carries something the format cannot state, and it is geometry rather than content. One canonicalisation goes with it — an extension object with
  nothing in it is not emitted, because absence says the same thing — and it is pinned by
  example rather than left to the round-trip property. Adding a model field means adding its ledger entry —
  `native` / `extension` / `degraded(to)` / `dropped(why)`, the last two owing a real reason.
  The ledger is the ONLY thing that classifies a field now. `censusSpatialModel` used to split
  its answer by whether a path was spelled under `x-whiteboard`, which worked only while the
  model WAS the format; it enumerates and no longer judges.

  The ledger is held from three sides, and each side catches something the others do not:
  the four directions of `.claude/rules/coverage-ledger.md` against the census's own path list
  (a missing entry, a stale one); a comparison against what `strictDegrade` REALLY drops, so a
  declaration is never merely a claim; and `toJsonCanvas` building its result field by field
  rather than by spread, so a field nobody projected fails the round-trip property instead of
  riding along.
- **Two things about those guards were learned by being wrong about them**, and both are the
  same mistake in different clothes — a guard that runs in one direction reads exactly like one
  that runs in both.
  - The behaviour comparison first filtered the ledger down to what was ALREADY lost, making
    the declared set a subset by construction. Under-declaring failed; **over-declaring passed
    all three guards** — marking `nodes[].color` (which strict mode never touches) as
    `extension` left every test green, which is a loss table that lies to a user about what an
    export costs. It asserts equality in both directions now, and the fixture's own coverage of
    every model position is asserted separately, since a fixture that stopped covering one
    would weaken the equality silently.
  - "Field by field" was true of the canvas's top-level fields and false of a node's or an
    edge's extension object, which was spread through whole — so the stated mechanism covered
    almost none of the fields it was written for. The decomposition reaches into every site
    now. It stops at a facet PAYLOAD deliberately: its contents belong to a plugin.
  Mutation-checked, all four: dropping `subpath` or `versionRef` from the projection fails the
  round-trip property; calling an `extension` entry `native`, or a `native` entry `extension`,
  fails the behaviour comparison.
- `serializeSpatial`'s `extended` mode now emits the projection's canonical key order rather
  than whatever order the caller's object carried. Nothing pins key order, and the artifact it
  changes is the JSON embedded in an exported PNG's `iTXt` chunk — stated here because it is a
  real change to a persisted artifact that no test would have reported.
- **`spatial/json-canvas.ts` is this package's own declaration of the wire shape**, and the
  home of the extension contract: `x-whiteboard` is the ONLY non-standard key an emitted
  document may carry, at three sites and no more. The published artifact
  (`json-schema.ts` -> `docs/reference/x-whiteboard.schema.json`, a vitest file snapshot;
  regenerate with `pnpm vitest run --project codec-node json-schema -u`) is generated from it,
  and `extension-contract.property.test.ts` enforces it. Extending what lives INSIDE
  `x-whiteboard` means regenerating the artifact in the same increment.
- The wire schemas are NOT `.strict()` and the model's are. A JSON Canvas document another tool
  wrote may legitimately carry vendor keys; the internal model must refuse a key it does not
  name. Both directions of that asymmetry are deliberate — see `.claude/rules/package-model.md`.
- The equivalence tests that proved the wire declaration a faithful LIFT of the model (an
  identical generated JSON Schema, and the same parsed value for every document) were deleted
  when the model diverged, exactly as the file said they would be. Keeping them past that point
  would have asserted the fork they existed to rule out; the round-trip property carries the
  claim now.
- The extension contract — `x-whiteboard` is the only non-standard key ever emitted, foreign keys
  on an imported document are stripped and never re-emitted — is pinned by
  `spatial/extension-contract.property.test.ts`; its machine-readable half is
  `docs/reference/x-whiteboard.schema.json` (generated by model).
- `parseMarkdownBody`/`stringifyMarkdownBody` do NOT parse/emit `[[wikiLink]]`/`![[embed]]` syntax
  directly — that stringifies to plain bracket-literal text. Resolving it into a typed `wikiLink`/
  `embed` node (or back out on export) is `references.ts`'s job, applied as a separate pass over
  already-parsed content with an injected resolver.
- `normalizeMdast` canonicalizes representational degrees of freedom markdown text cannot preserve
  (null vs. absent optional fields, empty vs. absent fence `meta`, adjacent merged text nodes,
  inferred `list.ordered`/`.spread`/`listItem.checked`) — it must run BEFORE any round-trip
  equality check, and its own idempotence/non-loss properties are tested ahead of the round-trip
  property so an over-eager normalizer can't mask real data loss.

## Tests

- Vitest project: `codec-node`.
- Round-trip properties: OKF (up to canonical key order), extended JSON Canvas (lossless), and
  markdown body (modulo `normalizeMdast`, over a syntax subset that excludes constructs with
  inherent CommonMark/GFM encoding ambiguities — adjacent same-delimiter inline spans, emphasis/
  strikethrough flanking-rule interactions, reference-style links/definitions, and non-HTML-shaped
  `html` node values, a line ending at a block's first or last text — the block boundary itself,
  which the writer emits raw where it encodes a boundary space as `&#x20;` — a blank line inside a
  text value (a paragraph break), a line ending inside a code span or inline math (CommonMark reads
  it as a space and the writer writes one whenever the next character could open a block; in an
  ATX-only heading it splits the heading), and a destination starting with `<` (the writer leaves
  it raw where the parser reads a pointy-bracket destination) — the last two pinned by
  `markdown-writer-limits-round-trip.test.ts`; each exclusion is commented at its filter). The
  text those properties draw is dense on purpose — words with spaces, markdown punctuation, line
  endings, characters outside ASCII (model's `markdownTextArbitrary`) — and the property held at
  1500 runs once the two newline exclusions were in; before the densification no text value
  carried a line ending at all.
- Every fast-check counterexample this package's own round-trip property found was pinned as an
  example test in `markdown/normalize.test.ts` before the corresponding `normalizeMdast` fix landed.

## Common mistakes (append as review finds them)

- Adding a hand-written interface next to a Zod schema instead of `z.infer`.
- Treating a markdown round-trip mismatch as a normalizeMdast bug before checking whether it is
  actually an inherent CommonMark/GFM encoding ambiguity (adjacent delimiters, flanking rules) —
  fix the property's arbitrary (exclude + comment the class), not the normalizer, in that case.
