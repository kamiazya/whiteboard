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
  node. No per-kind special casing. Extended mode is lossless (round-trip property).
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
  `html` node values; each exclusion is commented at its filter).
- Every fast-check counterexample this package's own round-trip property found was pinned as an
  example test in `markdown/normalize.test.ts` before the corresponding `normalizeMdast` fix landed.

## Common mistakes (append as review finds them)

- Adding a hand-written interface next to a Zod schema instead of `z.infer`.
- Treating a markdown round-trip mismatch as a normalizeMdast bug before checking whether it is
  actually an inherent CommonMark/GFM encoding ambiguity (adjacent delimiters, flanking rules) —
  fix the property's arbitrary (exclude + comment the class), not the normalizer, in that case.
