import type { ThemeTokens } from '@kamiazya/whiteboard-facet-engine'
import type { CanvasEdge, CanvasLine, SpatialNode } from '@kamiazya/whiteboard-model'
import { SPATIAL_THEME_FONT_FAMILY, SPATIAL_THEME_FONT_STACK } from '../../theme/font-family.js'
import {
  MARKDOWN_THEME_COMPACT,
  MARKDOWN_THEME_DOCUMENT,
  MARKDOWN_THEME_NODE,
} from '../../theme/markdown-theme.js'
import type { SpatialAppearanceResolver } from '../../theme/spatial-appearance.js'
import { SPATIAL_THEME_GEOMETRY } from '../../theme/spatial-geometry.js'
import { SPATIAL_DARK_PALETTE, SPATIAL_LIGHT_PALETTE } from '../../theme/spatial-palette.js'
import { createSpatialTheme } from '../../theme/spatial-theme.js'
import { TEXT_HALO_PAD_PX } from '../../theme/text-halo.js'
import {
  createThemedAppearance,
  markdownTheme,
  paletteFromTokens,
} from '../../theme/theme-asset.js'
import { f64Hex } from '../render-oracle/scene-dump.js'
import { type ResolverSpec, type ThemeCorpus, themeCorpus } from './corpus.js'

/**
 * The recorded answers of the TypeScript theme layer, which the Rust port
 * (`crates/core/canvas-render/src/theme`) replays exactly. A record holds its
 * inputs by name into the `meta` record's corpus, and every double an answer
 * holds is the hex of its IEEE bits, so a last-bit difference fails.
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

const fromJson = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

function tokensOf(corpus: ThemeCorpus, theme: string): ThemeTokens {
  const tokens = corpus.themes[theme]
  if (tokens === undefined) throw new Error(`theme-oracle: no theme ${theme}`)
  return tokens
}

function resolverOf(corpus: ThemeCorpus, spec: ResolverSpec): SpatialAppearanceResolver {
  if (spec.theme === null) return createSpatialTheme({ mode: spec.mode })
  return createThemedAppearance({
    tokens: tokensOf(corpus, spec.theme),
    mode: spec.mode,
    fontFamily: spec.family ?? SPATIAL_THEME_FONT_FAMILY,
  })
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

function resolverAnswer(corpus: ThemeCorpus, spec: ResolverSpec): ResolverRecord['out'] {
  const theme = resolverOf(corpus, spec)
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

function markdownAnswer(corpus: ThemeCorpus, theme: string | null, mode: 'light' | 'dark' | null) {
  const tokens = theme === null ? undefined : tokensOf(corpus, theme)
  return dump(markdownTheme(tokens, mode ?? undefined))
}

function constants(): Json {
  return dump({
    fontFamily: SPATIAL_THEME_FONT_FAMILY,
    fontStack: SPATIAL_THEME_FONT_STACK,
    haloPadPx: TEXT_HALO_PAD_PX,
    geometry: SPATIAL_THEME_GEOMETRY,
    markdownNode: MARKDOWN_THEME_NODE,
    markdownDocument: MARKDOWN_THEME_DOCUMENT,
    markdownCompact: MARKDOWN_THEME_COMPACT,
  })
}

const resolverId = (s: ResolverSpec) => `${s.theme ?? 'bundled'}/${s.mode}/${s.family ?? '-'}`

/** The recording, from the corpus alone. */
export function recording(): readonly OracleRecord[] {
  const corpus = fromJson(themeCorpus())
  const records: OracleRecord[] = [
    { kind: 'meta', corpus },
    { kind: 'constants', out: constants() },
  ]
  for (const mode of ['light', 'dark'] as const) {
    for (const theme of [null, ...Object.keys(corpus.themes)]) {
      records.push({
        kind: 'palette',
        id: `${theme ?? 'bundled'}/${mode}`,
        theme,
        mode,
        out: paletteAnswer(corpus, theme, mode),
      })
    }
  }
  for (const [theme, mode] of corpus.markdown) {
    records.push({
      kind: 'markdown',
      id: `${theme ?? 'none'}/${mode ?? '-'}`,
      theme,
      mode,
      out: markdownAnswer(corpus, theme, mode),
    })
  }
  for (const spec of corpus.resolvers) {
    records.push({
      kind: 'resolver',
      id: resolverId(spec),
      spec,
      out: resolverAnswer(corpus, spec),
    })
  }
  return records
}

/** Recomputes one recorded record from its own inputs; `meta` supplies the corpus. */
export function answerOf(corpus: ThemeCorpus, record: OracleRecord): OracleRecord {
  switch (record.kind) {
    case 'meta':
      return record
    case 'constants':
      return { ...record, out: constants() }
    case 'palette':
      return { ...record, out: paletteAnswer(corpus, record.theme, record.mode) }
    case 'markdown':
      return { ...record, out: markdownAnswer(corpus, record.theme, record.mode) }
    case 'resolver':
      return { ...record, out: resolverAnswer(corpus, record.spec) }
  }
}
