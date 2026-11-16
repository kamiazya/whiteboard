import type { ThemeTokens } from '@kamiazya/whiteboard-facet-engine'
import type { CanvasEdge, CanvasLine, SpatialNode } from '@kamiazya/whiteboard-model'
import { SPATIAL_THEME_FONT_FAMILY, SPATIAL_THEME_FONT_STACK } from '../../theme/font-family.js'
import type { SpatialAppearanceResolver } from '../../theme/spatial-appearance.js'
import { SPATIAL_THEME_GEOMETRY } from '../../theme/spatial-geometry.js'
import { SPATIAL_DARK_PALETTE, SPATIAL_LIGHT_PALETTE } from '../../theme/spatial-palette.js'
import { createSpatialTheme } from '../../theme/spatial-theme.js'
import { TEXT_HALO_PAD_PX } from '../../theme/text-halo.js'
import { paletteFromTokens } from '../../theme/theme-asset.js'
import { f64Hex } from '../render-oracle/scene-dump.js'
import type { ResolverSpec, ThemeCorpus } from './corpus.js'

/**
 * The recorded answers of the TypeScript theme layer, which the Rust port
 * (`crates/core/canvas-render/src/theme`) replays exactly. A record holds its
 * inputs by name into the `meta` record's corpus, and every double an answer
 * holds is the hex of its IEEE bits, so a last-bit difference fails.
 *
 * Part of the recording is frozen (ADR-0054 step 7, S18h): a themed
 * resolver, the markdown chrome and the markdown themes were answered by TypeScript that is deleted, so only the core answers them
 * now. `answerOf` re-answers the rest and hands a frozen part back as recorded.
 */

export type Json = null | boolean | string | number | readonly Json[] | { [key: string]: Json }

export interface MetaRecord {
  readonly kind: 'meta'
  readonly corpus: ThemeCorpus
}

interface ConstantsRecord {
  readonly kind: 'constants'
  readonly out: Json
}

interface PaletteRecord {
  readonly kind: 'palette'
  readonly id: string
  /** A bundled mode palette, or a theme's palette for a mode. */
  readonly theme: string | null
  readonly mode: 'light' | 'dark'
  readonly out: Json
}

interface MarkdownRecord {
  readonly kind: 'markdown'
  readonly id: string
  readonly theme: string | null
  readonly mode: 'light' | 'dark' | null
  readonly out: Json
}

export interface ResolverRecord {
  readonly kind: 'resolver'
  readonly id: string
  readonly spec: ResolverSpec
  readonly out: {
    readonly mode: Json
    readonly label: Json
    readonly syntax: Json
    readonly comment: Json
    readonly proposal: Json
    /** One answer per (node kind, colour), kinds outermost. */
    readonly nodes: readonly Json[]
    readonly edges: readonly Json[]
    readonly lines: readonly Json[]
  }
}

export type OracleRecord =
  | MetaRecord
  | ConstantsRecord
  | PaletteRecord
  | MarkdownRecord
  | ResolverRecord

/** Every number as its bits, every undefined key dropped, recursively. */
function dump(value: unknown): Json {
  if (typeof value === 'number') return f64Hex(value)
  if (Array.isArray(value)) return value.map(dump)
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, Json> = {}
    for (const [key, v] of Object.entries(value)) {
      if (v !== undefined && typeof v !== 'function') out[key] = dump(v)
    }
    return out
  }
  return value as Json
}

const orNull = (value: unknown): Json => (value === undefined ? null : dump(value))

function tokensOf(corpus: ThemeCorpus, theme: string): ThemeTokens {
  const tokens = corpus.themes[theme]
  if (tokens === undefined) throw new Error(`theme-oracle: no theme ${theme}`)
  return tokens
}

function nodeOf(
  resource: ThemeCorpus['nodeKinds'][number]['resource'],
  color: string | null,
): SpatialNode {
  return {
    id: 'n',
    x: 0,
    y: 0,
    width: 10,
    height: 10,
    ...(color === null ? {} : { color }),
    ...(resource === null ? {} : { resource }),
  } as unknown as SpatialNode
}

function routable(base: object, color: string | null): CanvasEdge & CanvasLine {
  return { id: 'e', ...base, ...(color === null ? {} : { color }) } as unknown as CanvasEdge &
    CanvasLine
}

function resolverAnswer(
  spec: ResolverSpec & { theme: null },
  corpus: ThemeCorpus,
): ResolverRecord['out'] {
  const theme: SpatialAppearanceResolver = createSpatialTheme({ mode: spec.mode })
  const nodes: Json[] = []
  for (const kind of corpus.nodeKinds) {
    for (const color of corpus.colors)
      nodes.push(dump(theme.resolveNode(nodeOf(kind.resource, color))))
  }
  const edge = (base: object) =>
    corpus.colors.map((color) => dump(theme.resolveEdge(routable(base, color))))
  return {
    mode: theme.mode ?? null,
    label: dump(theme.resolveLabel()),
    syntax: orNull(theme.resolveSyntax?.()),
    comment: orNull(theme.resolveComment?.()),
    proposal: orNull(theme.resolveProposal?.()),
    nodes,
    edges: edge({ from: { node: 'a' }, to: { node: 'b' } }),
    lines: edge({ from: { point: { x: 0, y: 0 } }, to: { point: { x: 1, y: 1 } } }),
  }
}

function paletteAnswer(corpus: ThemeCorpus, theme: string | null, mode: 'light' | 'dark') {
  if (theme === null) return dump(mode === 'light' ? SPATIAL_LIGHT_PALETTE : SPATIAL_DARK_PALETTE)
  return dump(paletteFromTokens(tokensOf(corpus, theme).palette[mode]))
}

/** The live constants, with the frozen markdown themes read from the recording. */
function constants(recorded: Json): Json {
  const frozen = recorded as {
    readonly markdownNode: Json
    readonly markdownDocument: Json
    readonly markdownCompact: Json
  }
  return {
    ...(dump({
      fontFamily: SPATIAL_THEME_FONT_FAMILY,
      fontStack: SPATIAL_THEME_FONT_STACK,
      haloPadPx: TEXT_HALO_PAD_PX,
      geometry: SPATIAL_THEME_GEOMETRY,
    }) as { [key: string]: Json }),
    markdownNode: frozen.markdownNode,
    markdownDocument: frozen.markdownDocument,
    markdownCompact: frozen.markdownCompact,
  }
}

/**
 * Recomputes one recorded record from its own inputs, `meta` supplying the
 * corpus; a frozen record, or a frozen part of one, is handed back as recorded.
 */
export function answerOf(corpus: ThemeCorpus, record: OracleRecord): OracleRecord {
  switch (record.kind) {
    case 'meta':
      return record
    case 'constants':
      return { ...record, out: constants(record.out) }
    case 'palette':
      return { ...record, out: paletteAnswer(corpus, record.theme, record.mode) }
    case 'markdown':
      return record
    case 'resolver': {
      const { spec } = record
      return spec.theme === null
        ? { ...record, out: resolverAnswer({ ...spec, theme: null }, corpus) }
        : record
    }
  }
}
