/**
 * The published loss table — [ADR-0035](../../../../docs/contributing/adr/0035-model-and-format.md)
 * decision 2's other half.
 *
 * Decision 2 replaces "the model IS JSON Canvas" with two checkable claims: a
 * round-trip property over the expressible subset, and *a published loss table
 * for everything else*. The property has existed since slice 1; this is the
 * publication, generated from `JSON_CANVAS_PROJECTION` so it cannot drift from
 * what the code actually does.
 *
 * It is generated rather than written for the same reason
 * `x-whiteboard.schema.json` is: a hand-kept table describing a first-party
 * format promise is a promise that goes stale silently, and the one thing a
 * reader needs from it is that it is true today.
 */
import { censusSpatialModel } from './census.js'
import { type FieldProjection, JSON_CANVAS_PROJECTION } from './projection.js'

const KIND_ORDER = ['native', 'degraded', 'extension', 'dropped'] as const

const HEADING: Record<(typeof KIND_ORDER)[number], string> = {
  native: 'Stated by JSON Canvas 1.0',
  degraded: 'Stated, but not exactly',
  extension: 'Carried on `x-whiteboard`',
  dropped: 'Cannot cross at all',
}

const BLURB: Record<(typeof KIND_ORDER)[number], string> = {
  native:
    'Every reader of the format gets these, in both export modes. Nothing is lost and nothing needs the extension key.',
  degraded:
    'The format has the field and cannot hold the value. What a reader gets instead is named per row; the document still draws in the right place.',
  extension:
    'Survives the `extended` export and disappears from the `strict` one, which emits plain JSON Canvas 1.0. A reader that drops the key keeps the whole of what the format can state.',
  dropped: 'Named here so the absence is a decision rather than a surprise.',
}

function rowsFor(
  kind: (typeof KIND_ORDER)[number],
  positions: readonly string[],
): readonly { readonly path: string; readonly note: string }[] {
  return positions
    .filter((path) => JSON_CANVAS_PROJECTION[path]?.kind === kind)
    .map((path) => ({ path, note: noteFor(JSON_CANVAS_PROJECTION[path] as FieldProjection) }))
}

function noteFor(projection: FieldProjection): string {
  switch (projection.kind) {
    case 'degraded':
      return `crosses as ${projection.to}`
    case 'dropped':
      return projection.why
    case 'extension':
      return 'dropped by `strict`'
    case 'native':
      return 'survives both modes'
  }
}

/**
 * The table as markdown, for `docs/reference/json-canvas-loss.md`.
 *
 * Scoped to the MODEL's own positions. A facet bucket is one row rather than a
 * descent: what a deployment's plugins put inside it is theirs, and a document
 * carrying a plugin's payload loses that payload in strict mode whatever the
 * payload is — which is the whole of what this table can honestly promise
 * about it.
 */
export function jsonCanvasLossTable(): string {
  const census = censusSpatialModel([])
  const positions = [...census.paths, ...census.facetBuckets].sort()
  const counted = KIND_ORDER.map((kind) => ({ kind, rows: rowsFor(kind, positions) }))
  const total = counted.reduce((sum, { rows }) => sum + rows.length, 0)
  const surviving = counted
    .filter(({ kind }) => kind === 'native' || kind === 'degraded')
    .reduce((sum, { rows }) => sum + rows.length, 0)

  const lines: string[] = [
    '<!-- Generated from packages/codec/src/spatial/projection.ts. Do not edit by hand:',
    '     `pnpm vitest run --project codec-node loss-table -u` regenerates it. -->',
    '',
    '# What a JSON Canvas export keeps, and what it costs',
    '',
    'A whiteboard document is not a JSON Canvas file. JSON Canvas 1.0 is a **projection** of it',
    '([ADR-0035](../contributing/adr/0035-model-and-format.md)), and first-party support means a',
    'tested projection rather than an identity: a round-trip property over the expressible subset,',
    'and this table for everything else.',
    '',
    `The model can hold **${total}** field positions. **${surviving}** of them are something the format`,
    `can state; **${total - surviving}** reach a reader only through the single extension key, or not at all.`,
    '',
    'Two export modes, and the difference between them is exactly the `x-whiteboard` rows below:',
    '',
    '- **`extended`** — JSON Canvas 1.0 plus the one extension key. Lossless over everything the key',
    '  can hold. This is what `wb_document_get` emits by default.',
    '- **`strict`** — plain JSON Canvas 1.0, the extension key removed entirely',
    '  (`wb_document_get` with `options.strict: true`).',
    '',
  ]

  for (const { kind, rows } of counted) {
    lines.push(`## ${HEADING[kind]} — ${rows.length}`, '', BLURB[kind], '')
    if (rows.length === 0) {
      lines.push('_None today._', '')
      continue
    }
    lines.push('| field | what a reader gets |', '| --- | --- |')
    for (const { path, note } of rows) lines.push(`| \`${path}\` | ${note} |`)
    lines.push('')
  }

  lines.push(
    '## What this table does not cover',
    '',
    '- **What is inside a facet bucket.** A `…/*` row is one entry because the format can say a bucket',
    '  is present and nothing about its contents, and those contents belong to whichever plugins a',
    '  deployment carries. Every one of them is lost in `strict`, whatever it is.',
    '- **OKF Markdown.** This is the spatial side only. A markdown document round-trips through OKF',
    '  preserving root keys this codebase does not model, which is a different promise made a',
    '  different way.',
    '- **`wb_scene_render`.** SVG is an explicitly lossy rendering, not a document format, and has',
    '  never claimed otherwise.',
    '',
    '← Back to [reference](README.md)',
  )
  return `${lines.join('\n')}\n`
}
