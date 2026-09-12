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
import { OCIF_PROJECTION } from './ocif-projection.js'
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

/**
 * The rows of one section, for whichever ledger is being published.
 *
 * Two formats share this and nothing else: each owes its own headings, its own
 * blurbs and its own prose, because what `extension` COSTS is the difference
 * between them — JSON Canvas's strict mode deletes the key, and OCIF requires a
 * conforming reader to preserve it. A shared sentence there would be wrong for
 * one of the two, which is the only kind of sharing worth refusing.
 */
function rowsFor(
  ledger: Readonly<Record<string, FieldProjection>>,
  kind: (typeof KIND_ORDER)[number],
  positions: readonly string[],
  note: (projection: FieldProjection) => string,
): readonly { readonly path: string; readonly note: string }[] {
  return positions
    .filter((path) => ledger[path]?.kind === kind)
    .map((path) => ({ path, note: note(ledger[path] as FieldProjection) }))
}

/** The model's own positions, which is what every table here is scoped to. */
function modelPositions(): readonly string[] {
  const census = censusSpatialModel([])
  return [...census.paths, ...census.facetBuckets].sort()
}

/** One `## Heading — n` section per kind, with its table. */
function sections(
  counted: readonly {
    readonly kind: (typeof KIND_ORDER)[number]
    readonly rows: readonly { readonly path: string; readonly note: string }[]
  }[],
  heading: Record<(typeof KIND_ORDER)[number], string>,
  blurb: Record<(typeof KIND_ORDER)[number], string>,
): readonly string[] {
  const lines: string[] = []
  for (const { kind, rows } of counted) {
    lines.push(`## ${heading[kind]} — ${rows.length}`, '', blurb[kind], '')
    if (rows.length === 0) {
      lines.push('_None today._', '')
      continue
    }
    lines.push('| field | what a reader gets |', '| --- | --- |')
    for (const { path, note } of rows) lines.push(`| \`${path}\` | ${note} |`)
    lines.push('')
  }
  return lines
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
  const positions = modelPositions()
  const counted = KIND_ORDER.map((kind) => ({
    kind,
    rows: rowsFor(JSON_CANVAS_PROJECTION, kind, positions, noteFor),
  }))
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

  lines.push(...sections(counted, HEADING, BLURB))

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

const OCIF_HEADING: Record<(typeof KIND_ORDER)[number], string> = {
  native: 'Stated by OCIF v0.7.0',
  degraded: 'Stated, but not in the same shape',
  extension: 'Carried on a `@whiteboard/*` extension',
  dropped: 'Cannot cross at all',
}

const OCIF_BLURB: Record<(typeof KIND_ORDER)[number], string> = {
  native:
    'A conforming reader gets these and UNDERSTANDS them. A facet bucket is in here because OCIF’s `data[]` is the same mechanism — one ordinary extension per facet, keyed by the facet key — not because it is tolerated on a vendor key.',
  degraded:
    'The format has somewhere to put the value and not the same shape for it. What a reader gets instead is named per row, and this projection reads it back the same way, so the row is what a round trip through a foreign tool really costs.',
  extension:
    'A conforming reader must PRESERVE an extension it does not understand, so a round trip through a foreign tool deletes none of these. What is lost is comprehension, not data: the tool carries the bytes and cannot act on them. There is no second mode here that drops the key — that is JSON Canvas’s `strict`, and OCIF has no equivalent.',
  dropped: 'Named here so an absence would be a decision rather than a surprise.',
}

function ocifNoteFor(projection: FieldProjection): string {
  switch (projection.kind) {
    case 'degraded':
      return `crosses as ${projection.to}`
    case 'dropped':
      return projection.why
    case 'extension':
      return 'preserved, not understood'
    case 'native':
      return 'stated by the format'
  }
}

/**
 * The OCIF table, for `docs/reference/ocif-loss.md` —
 * [ADR-0036](../../../../docs/contributing/adr/0036-ocif-projection.md)'s
 * measurement, published for the same reason its sibling is.
 *
 * Reading the two side by side is the point. They are generated from the same
 * census, so the rows line up, and where they disagree is where the choice of
 * format actually costs a user something.
 */
export function ocifLossTable(): string {
  const positions = modelPositions()
  const counted = KIND_ORDER.map((kind) => ({
    kind,
    rows: rowsFor(OCIF_PROJECTION, kind, positions, ocifNoteFor),
  }))
  const total = counted.reduce((sum, { rows }) => sum + rows.length, 0)
  const understood = counted
    .filter(({ kind }) => kind === 'native' || kind === 'degraded')
    .reduce((sum, { rows }) => sum + rows.length, 0)

  const lines: string[] = [
    '<!-- Generated from packages/codec/src/spatial/ocif-projection.ts. Do not edit by hand:',
    '     `pnpm vitest run --project codec-node loss-table -u` regenerates it. -->',
    '',
    '# What an OCIF export keeps, and what it costs',
    '',
    '[OCIF v0.7.0](https://spec.canvasprotocol.org/) is a **third projection** of a whiteboard',
    'document ([ADR-0036](../contributing/adr/0036-ocif-projection.md)), beside JSON Canvas 1.0 and',
    'OKF Markdown. The claim first-party support makes is the same one ADR-0035 made for JSON',
    'Canvas: a round-trip property over the expressible subset, and this table for everything else.',
    '',
    `The model can hold **${total}** field positions. **${understood}** of them are something OCIF can`,
    `state in its own vocabulary; the remaining **${total - understood}** ride an extension of ours.`,
    '',
    '**Nothing is dropped**, and that is the difference worth knowing before choosing a format.',
    'OCIF’s conformance rules require a reader to preserve an extension it does not understand, so a',
    'document that goes out to a foreign tool and comes back still holds every position it left',
    'with. A strict JSON Canvas export, by contrast, deletes its extension key outright.',
    '',
    'Read this beside [the JSON Canvas table](json-canvas-loss.md): the rows are the same positions,',
    'and where the two disagree is where the choice of format costs a reader something real.',
    '',
    ...sections(counted, OCIF_HEADING, OCIF_BLURB),
    '## What this table does not cover',
    '',
    '- **What is inside a facet bucket.** A `…/*` row is one entry. Unlike the JSON Canvas table,',
    '  here that is a statement about scope rather than about loss: each facet crosses as its own',
    '  OCIF extension, so its contents survive whatever they are — this table simply cannot',
    '  enumerate what a deployment’s plugins put there.',
    '- **What OCIF can state that this model cannot hold.** Rotation, 3D positions, ports,',
    '  inheritance and pages are all in the specification and have no position here to lose. A',
    '  document arriving with them keeps them as unread extension data.',
    '- **OKF Markdown.** This is the spatial side only.',
    '',
    '← Back to [reference](README.md)',
  ]
  return `${lines.join('\n')}\n`
}
