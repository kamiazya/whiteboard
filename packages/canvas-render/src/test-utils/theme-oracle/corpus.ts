import type { ThemeTokens } from '@kamiazya/whiteboard-facet-engine'
import { VISUAL_THEMES } from '@kamiazya/whiteboard-plugin-visual'
import type { SpatialThemeMode } from '../../theme/spatial-theme-mode.js'

/**
 * What the theme oracle asks: every bundled theme, the shapes of token bundle
 * the bundled ones do not reach (no optional token at all, each half of a
 * group frame alone, a chrome neutral in one mode only), and the node kinds and
 * colours a resolver is asked about. The corpus is recorded in the `meta`
 * record, so a replay needs no module of this package.
 */

interface ResourceInput {
  readonly mimeType: string
  readonly content?: string
  readonly location?: string
}

/** A node as the resolvers read it: what it shows and its colour. */
interface NodeKindInput {
  readonly name: string
  readonly resource: ResourceInput | null
}

export interface ResolverSpec {
  /** A key of `themes`; null is the bundled per-mode theme. */
  readonly theme: string | null
  readonly mode: SpatialThemeMode
  /** The family a themed resolver declares; null for a bundled one. */
  readonly family: string | null
}

export interface ThemeCorpus {
  readonly themes: Readonly<Record<string, ThemeTokens>>
  readonly nodeKinds: readonly NodeKindInput[]
  /** `null` is a node or edge that carries no colour. */
  readonly colors: readonly (string | null)[]
  readonly resolvers: readonly ResolverSpec[]
  /** Pairs asked of `markdownTheme`: a theme (or none) and a mode (or none). */
  readonly markdown: readonly (readonly [string | null, SpatialThemeMode | null])[]
}

const sketch = VISUAL_THEMES.sketch
const neon = VISUAL_THEMES.neon

function required(tokens: ThemeTokens | undefined, name: string): ThemeTokens {
  if (tokens === undefined) throw new Error(`theme-oracle: bundled theme ${name} is missing`)
  return tokens
}

const withoutOptionals = (base: ThemeTokens): ThemeTokens => {
  const { strokeWidthPx: _w, fontFamily: _f, glow: _g, defaults: _d, ...rest } = base
  const { markdownChrome: _l, ...light } = base.palette.light
  const { markdownChrome: _k, ...dark } = base.palette.dark
  return { ...rest, defaults: {}, palette: { light, dark } }
}

const NODE_KINDS: ThemeCorpus['nodeKinds'] = [
  { name: 'text', resource: { mimeType: 'text/markdown', content: 'hello' } },
  { name: 'text-empty', resource: { mimeType: 'text/markdown', content: '' } },
  { name: 'link', resource: { mimeType: 'text/uri-list', location: 'https://example.com' } },
  { name: 'file', resource: { mimeType: 'application/pdf', location: 'a.pdf' } },
  // Content wins over a location: the kinds are tested in a fixed order.
  {
    name: 'content-and-location',
    resource: { mimeType: 'text/uri-list', content: 'x', location: 'https://example.com' },
  },
  // A resource nothing claims: no content and no location.
  { name: 'unclaimed', resource: { mimeType: 'application/x-unknown' } },
  { name: 'unclaimed-uri', resource: { mimeType: 'text/uri-list' } },
  { name: 'frame', resource: null },
]

const COLORS: ThemeCorpus['colors'] = [
  null,
  '1',
  '2',
  '3',
  '4',
  '5',
  '6',
  '0',
  '7',
  '#ff00aa',
  '#FFF',
  '#',
  'red',
  '',
  ' 1',
]

const MARKDOWN_PAIRS: ThemeCorpus['markdown'] = [
  [null, null],
  [null, 'light'],
  [null, 'dark'],
  ['sketch', null],
  ['sketch', 'light'],
  ['sketch', 'dark'],
  ['neon', 'light'],
  ['neon', 'dark'],
  ['bare', 'light'],
  ['bare', 'dark'],
  ['chrome-dark-only', 'light'],
  ['chrome-dark-only', 'dark'],
  ['chrome-dark-only', null],
]

function themeVariants(): Record<string, ThemeTokens> {
  const sketchTokens = required(sketch, 'sketch')
  const neonTokens = required(neon, 'neon')
  const bare = withoutOptionals(neonTokens)
  const { markdownChrome: _drop, ...lightNoChrome } = neonTokens.palette.light
  const themes: Record<string, ThemeTokens> = {
    sketch: sketchTokens,
    neon: neonTokens,
    bare,
    // A frame that declares only its width, and only the dash: the two halves
    // of `groupFrame` are independent tokens.
    'frame-width': { ...bare, defaults: { groupFrame: { strokeWidth: 3.25 } } },
    'frame-dash': { ...bare, defaults: { groupFrame: { strokeDasharray: '2 6' } } },
    // The chrome neutral in dark only, and a weight and glow without a family.
    'chrome-dark-only': {
      ...neonTokens,
      palette: { light: lightNoChrome, dark: neonTokens.palette.dark },
    },
  }
  return themes
}

function resolverSpecs(themes: Readonly<Record<string, ThemeTokens>>): ResolverSpec[] {
  const resolvers: ResolverSpec[] = []
  for (const mode of ['light', 'dark'] as const) {
    resolvers.push({ theme: null, mode, family: null })
    for (const theme of Object.keys(themes)) {
      resolvers.push({ theme, mode, family: 'Roboto' })
    }
    resolvers.push({ theme: 'sketch', mode, family: 'Yomogi' })
    resolvers.push({ theme: 'neon', mode, family: 'Inter' })
  }
  return resolvers
}

export function themeCorpus(): ThemeCorpus {
  const themes = themeVariants()
  return {
    themes,
    nodeKinds: NODE_KINDS,
    colors: COLORS,
    resolvers: resolverSpecs(themes),
    markdown: MARKDOWN_PAIRS,
  }
}
