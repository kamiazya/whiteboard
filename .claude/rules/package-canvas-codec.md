---
paths:
  - "packages/canvas-codec/**"
  # apps/web imports this package directly and is NOT source-scanned by arch-lint, so the
  # Consumers note below is the only place that boundary is written down — it has to reach
  # whoever is editing apps/web, not just whoever is editing this package.
  - "apps/web/**"
---

# canvas-codec — OKF-Markdown / JSON Canvas serialize+parse + remark pipeline

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
  deferred to `canvas-workspace` (see architecture-map.md).
- Scene graph, layout, rendering (`canvas-render`, planned).
- Storage, HTTP/MCP surfaces, Inversify DI (composition roots only: `mcp-server`, `apps/web`).
- Any runtime behavior beyond parsing/serializing a single document.

## Dependency rules

Runtime dependencies: `@kamiazya/whiteboard-canvas-model` (workspace), `zod`, and the closed
`unified`/`remark-*`/`yaml` set (all `catalog:`). Forbidden: `node:*`, DOM globals, `inversify`,
`loro-crdt`. Enforced by `tools/arch-lint` (`arch-lint-node` vitest project) — both the banned-
construct scan and the package.json dependency-direction check run against this package's `src/`.

## Consumers

Besides `canvas-workspace` and `canvas-viewer`, `apps/web` depends on this package directly (its
markdown-editor preview pane calls `parseMarkdownBody` to feed canvas-render's
`layoutMdastBlocks`/`renderSceneToSvg`, the same parse path `canvas-viewer` and `mcp-server` use
for spatial text nodes and export — kept as one renderer instead of a second markdown-to-HTML
fallback). `apps/web` is a composition root, so this is an allowed forward dependency per
`architecture-map.md`; it is not source-scanned by `tools/arch-lint` (only the reverse-direction
guard applies to composition roots), so this note is the boundary's only documentation.

## Conventions

- Every exported type is `z.infer`-derived (`OkfMarkdownDocument`, `OkfMarkdownFrontmatter`) or
  re-exported from canvas-model — never a hand-written interface next to a schema.
- Parsers (`parseOkf`, `parseSpatial`) are total: they return `CodecParseResult<T>`, never throw a
  raw `ZodError`/`SyntaxError`, and never silently return a partial value. Every failure stage
  (`yaml` / `frontmatter-schema` / `json-syntax` / `json-canvas-schema`) has a pinned example test.
- OKF facets-domain keys are emitted in canonical lexicographic order on serialize — authoring
  order is not preserved. Facet values are validated against `yamlSafeValueSchema` before emission;
  a non-yaml-safe value (undefined/NaN/Infinity/bigint/function/symbol/cyclic) is a typed error,
  not a corrupt YAML file.
- Strict JSON Canvas degradation is ONE uniform rule: drop the entire `x-whiteboard` key from every
  node. No per-kind special casing. Extended mode is lossless (round-trip property).
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

- Vitest project: `canvas-codec-node`.
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
