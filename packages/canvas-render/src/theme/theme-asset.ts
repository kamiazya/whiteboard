// A registered theme asset (the engine's token contract, ADR-0030 decision
// 3) turned into the ONE thing a layout consumes: a `SpatialAppearanceResolver`
// for a mode. The mapping is explicit field by field rather than a cast, so a
// field added to either side is a type error here and a failing round-trip
// test in theme-asset.test.ts — the two shapes are meant to be one, and the
// contract lives in the engine only so that ADR-0013 decision 8 can build on
// it without moving anything.
import type { PaletteTokens, ThemeTokens } from '@kamiazya/whiteboard-facet-engine'
import type { SpatialNode } from '@kamiazya/whiteboard-model'
import type { RoutableElement } from '@kamiazya/whiteboard-scene'
import type {
  SpatialAppearanceResolver,
  SpatialNodeAppearance,
} from '../layout/nodes/spatial-appearance.js'
import { MARKDOWN_THEME_NODE, type MarkdownTheme } from './markdown-theme.js'
import type { SpatialPalette } from './spatial-palette.js'
import { createSpatialTheme, type SpatialThemeMode } from './spatial-theme.js'

export function paletteFromTokens(tokens: PaletteTokens): SpatialPalette {
  return {
    node: {
      text: { fill: tokens.node.text.fill, stroke: tokens.node.text.stroke },
      file: { fill: tokens.node.file.fill, stroke: tokens.node.file.stroke },
      link: { fill: tokens.node.link.fill, stroke: tokens.node.link.stroke },
      group: { fill: tokens.node.group.fill, stroke: tokens.node.group.stroke },
    },
    edgeStroke: tokens.edgeStroke,
    labelFill: tokens.labelFill,
    surface: tokens.surface,
    cornerRadiusPx: tokens.cornerRadiusPx,
    presets: {
      '1': { stroke: tokens.presets['1'].stroke, fill: tokens.presets['1'].fill },
      '2': { stroke: tokens.presets['2'].stroke, fill: tokens.presets['2'].fill },
      '3': { stroke: tokens.presets['3'].stroke, fill: tokens.presets['3'].fill },
      '4': { stroke: tokens.presets['4'].stroke, fill: tokens.presets['4'].fill },
      '5': { stroke: tokens.presets['5'].stroke, fill: tokens.presets['5'].fill },
      '6': { stroke: tokens.presets['6'].stroke, fill: tokens.presets['6'].fill },
    },
    syntax: {
      keyword: tokens.syntax.keyword,
      string: tokens.syntax.string,
      number: tokens.syntax.number,
      comment: tokens.syntax.comment,
    },
    comment: {
      pin: { fill: tokens.comment.pin.fill, stroke: tokens.comment.pin.stroke },
      bubble: { fill: tokens.comment.bubble.fill, stroke: tokens.comment.bubble.stroke },
    },
    proposal: { edge: tokens.proposal.edge, bubbleFill: tokens.proposal.bubbleFill },
    // Spread rather than assigned: the bundled palettes declare none, and a
    // present-but-undefined key would make the two shapes differ by a key.
    ...(tokens.markdownChrome === undefined ? {} : { markdownChrome: tokens.markdownChrome }),
  }
}

/**
 * The markdown metrics a body inside a THEMED canvas is laid out with: the
 * node theme, with the theme's own neutral where its palette names one.
 *
 * A body is two-thirds furniture — the code panel, the blockquote rail, the
 * checkbox — and without this the prose took the theme while the furniture
 * around it stayed the bundled slate on every board.
 */
export function markdownTheme(
  tokens: ThemeTokens | undefined,
  mode: SpatialThemeMode | undefined,
): MarkdownTheme {
  const chrome = tokens?.palette[mode ?? 'light'].markdownChrome
  return chrome === undefined
    ? MARKDOWN_THEME_NODE
    : { ...MARKDOWN_THEME_NODE, chromeColor: chrome }
}

export interface ThemedAppearanceOptions {
  readonly tokens: ThemeTokens
  readonly mode: SpatialThemeMode
  /**
   * The family every label and body run DECLARES — already resolved by the
   * caller against what its surface can measure, because the family named
   * in the SVG must be the family the coordinates were measured with
   * (font-family.ts). A theme's own family arrives here only when a face
   * exists; otherwise the bundled one does, and the layout reports it.
   */
  readonly fontFamily: string
}

// Memoized per (tokens, mode, family) so a layout that resolves the same
// theme on every frame hands the editor the SAME resolver object: the
// per-mode defaults are frozen singletons for exactly this reason
// (spatial-theme.ts), and a themed canvas must not lose that property.
// Keyed weakly on the tokens object — an asset is a module-level constant in
// its plugin, so identity is the right key and nothing is retained past it.
const MEMO = new WeakMap<ThemeTokens, Map<string, SpatialAppearanceResolver>>()

export function createThemedAppearance(
  options: ThemedAppearanceOptions,
): SpatialAppearanceResolver {
  const { tokens, mode, fontFamily } = options
  const perTokens = MEMO.get(tokens) ?? new Map<string, SpatialAppearanceResolver>()
  MEMO.set(tokens, perTokens)
  const key = `${mode}|${fontFamily}`
  const hit = perTokens.get(key)
  if (hit !== undefined) return hit

  const base = createSpatialTheme({ mode, palette: paletteFromTokens(tokens.palette[mode]) })
  const frame = tokens.defaults.groupFrame
  // The halo rides node chrome and edges in the element's own paint. Not a
  // label: a 12px glyph blurred at three deviations thickens into a smudge,
  // and the label already sits on its halo pill. Not a group frame: the
  // largest and least informative thing on the board to bloom. Comment and
  // proposal chrome come from the base resolver untouched.
  const glow = tokens.glow === undefined ? {} : { glow: { radiusPx: tokens.glow.radiusPx } }
  // The theme's line weight reaches node chrome and edges — never a label,
  // which is filled text — and a group frame's own width, when the theme
  // declares one, wins over it below.
  const weight = tokens.strokeWidthPx === undefined ? {} : { strokeWidth: tokens.strokeWidthPx }
  const resolveNode = (node: SpatialNode): SpatialNodeAppearance => {
    const resolved = base.resolveNode(node)
    const framed =
      node.type === 'group' && frame !== undefined
        ? {
            ...(frame.strokeDasharray === undefined
              ? {}
              : { strokeDasharray: frame.strokeDasharray }),
            ...(frame.strokeWidth === undefined ? {} : { strokeWidth: frame.strokeWidth }),
          }
        : {}
    const halo = node.type === 'group' ? {} : glow
    return { ...resolved, appearance: { ...resolved.appearance, ...weight, ...framed, ...halo } }
  }
  const themed: SpatialAppearanceResolver = Object.freeze({
    ...base,
    mode,
    resolveNode,
    resolveEdge: (edge: RoutableElement) => {
      const resolved = base.resolveEdge(edge)
      return resolved === undefined ? undefined : { ...resolved, ...weight, ...glow }
    },
    resolveLabel: () => ({ ...base.resolveLabel(), fontFamily }),
  })
  perTokens.set(key, themed)
  return themed
}
