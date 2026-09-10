/**
 * The engine's THEME TOKEN CONTRACT (ADR-0030 decision 3): the one shape a
 * registered theme asset has. A document never carries these values — it
 * names an asset by id (`<plugin>.<name>`), and the asset supplies them.
 *
 * Declared here, in the engine, rather than in the renderer that consumes
 * it, so that it is a PREFIX of ADR-0013 decision 8's token contract: when
 * views and slots land, the type does not move and neither does any asset.
 * The renderer maps these tokens onto its own palette type through
 * `z.infer`; it never re-declares them.
 *
 * Every colour is six-digit hex. Not a stylistic choice: the PNG export path
 * (resvg) parses no `oklch()`, and an 8-digit alpha hex is not SVG 1.1, so a
 * theme authored in the app's CSS colour space would export wrong. The
 * medium-neutral contract is the one every medium here can read.
 */
import { z } from 'zod'

const hexColorSchema = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, 'must be a six-digit hex colour (resvg parses no oklch)')

/** A fill may be absent — an outlined node on a dark surface draws no fill. */
const fillSchema = z.union([hexColorSchema, z.literal('none')])

/** A registered thing's id: `<plugin>.<name>`, both key segments. */
export const namespacedIdSchema = z
  .string()
  .regex(/^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*$/, 'must be a namespaced id like "visual.diamond"')

const nodeStyleTokensSchema = z.object({
  fill: fillSchema,
  stroke: hexColorSchema,
})

const presetAccentSchema = z.object({
  stroke: hexColorSchema,
  fill: hexColorSchema,
})

/**
 * One MODE's palette. The field set mirrors the renderer's `SpatialPalette`
 * deliberately — a theme has to be able to say everything the bundled
 * palettes say, or a themed canvas would fall back to bundled colours for
 * the parts it could not express and read as two themes at once.
 */
export const paletteTokensSchema = z.object({
  node: z.object({
    text: nodeStyleTokensSchema,
    file: nodeStyleTokensSchema,
    link: nodeStyleTokensSchema,
    group: nodeStyleTokensSchema,
  }),
  edgeStroke: hexColorSchema,
  labelFill: hexColorSchema,
  surface: hexColorSchema,
  cornerRadiusPx: z.number().nonnegative(),
  presets: z.object({
    '1': presetAccentSchema,
    '2': presetAccentSchema,
    '3': presetAccentSchema,
    '4': presetAccentSchema,
    '5': presetAccentSchema,
    '6': presetAccentSchema,
  }),
  syntax: z.object({
    keyword: hexColorSchema,
    string: hexColorSchema,
    number: hexColorSchema,
    comment: hexColorSchema,
  }),
  comment: z.object({
    pin: nodeStyleTokensSchema,
    bubble: nodeStyleTokensSchema,
  }),
  proposal: z.object({
    edge: hexColorSchema,
    bubbleFill: hexColorSchema,
  }),
})

export type PaletteTokens = z.infer<typeof paletteTokensSchema>

/**
 * How a group's frame is drawn — the one HOW token that is per node kind,
 * because a group frame is the thing a theme most wants to restyle (a
 * dashed pencil box, a faint neon boundary) while every other kind's chrome
 * is the palette's business.
 */
export const groupFrameTokensSchema = z.object({
  strokeDasharray: z.string().min(1).optional(),
  strokeWidth: z.number().positive().optional(),
})

/**
 * Same vocabulary as model's `edgeRoutingStyleSchema`, spelled here because
 * this package depends on zod alone. The renderer's tests pin that the two
 * agree, the way `visual.shape`'s vocabulary is pinned against the outline
 * table.
 */
export const themeEdgeRoutingSchema = z.enum(['straight', 'orthogonal', 'curved'])

export const themeTokensSchema = z.object({
  /** How outlines and edges are inked: crisp geometry, or seeded jitter. */
  ink: z.enum(['clean', 'sketch']),
  /**
   * The line weight of document chrome and edges, in px. Absent means the
   * renderer's default hairline. A pencil is heavier than a hairline, and a
   * glow blooms from the paint it has — the same number serves both.
   */
  strokeWidthPx: z.number().positive().optional(),
  /**
   * A font FAMILY name and nothing more. Whether a face exists on a surface
   * is ADR-0011's provider question; a missing face degrades to the bundled
   * family and says so.
   */
  fontFamily: z.string().min(1).optional(),
  /** A soft halo on node chrome, edges and symbols, in the element's own colour. */
  glow: z.object({ radiusPx: z.number().positive() }).optional(),
  /** Both modes, always: the canvas surface follows the UI, never the theme. */
  palette: z.object({
    light: paletteTokensSchema,
    dark: paletteTokensSchema,
  }),
  /**
   * DEFAULTS for what is drawn (ADR-0030 decision 4). An explicit facet on
   * the object always wins; a theme never overrides a silhouette somebody
   * chose or moves an edge's waypoints. `nodeShape` is a namespaced shape
   * id, so an asset from one plugin may name another plugin's geometry —
   * resolved at render time, degrading to a rect when unknown.
   */
  defaults: z
    .object({
      nodeShape: namespacedIdSchema.optional(),
      edgeRouting: themeEdgeRoutingSchema.optional(),
      groupFrame: groupFrameTokensSchema.optional(),
    })
    .default({}),
})

export type ThemeTokens = z.infer<typeof themeTokensSchema>
/** What a plugin WRITES: `defaults` may be omitted, and the registry fills it in. */
export type ThemeTokensInput = z.input<typeof themeTokensSchema>

/**
 * An icon set entry a plugin may register as an asset. Structural: the
 * renderer's own icon vocabulary is the same four primitives, and this
 * package cannot depend on the renderer to say so.
 */
export const iconAssetSchema = z.object({
  viewBox: z.string().min(1).optional(),
  geometry: z
    .array(
      z.union([
        z.object({ tag: z.literal('path'), d: z.string().min(1) }),
        z.object({
          tag: z.literal('rect'),
          x: z.number(),
          y: z.number(),
          width: z.number(),
          height: z.number(),
          rx: z.number().optional(),
        }),
        z.object({ tag: z.literal('circle'), cx: z.number(), cy: z.number(), r: z.number() }),
        z.object({
          tag: z.literal('ellipse'),
          cx: z.number(),
          cy: z.number(),
          rx: z.number(),
          ry: z.number(),
        }),
      ]),
    )
    .min(1),
})

export type IconAsset = z.infer<typeof iconAssetSchema>

const SAMPLE_LIGHT: PaletteTokens = {
  node: {
    text: { fill: '#ffffff', stroke: '#3d3d3d' },
    file: { fill: '#f5f5f5', stroke: '#3d3d3d' },
    link: { fill: '#eef4ff', stroke: '#3d3d3d' },
    group: { fill: 'none', stroke: '#3d3d3d' },
  },
  edgeStroke: '#3d3d3d',
  labelFill: '#2a2a2a',
  surface: '#fffdf7',
  cornerRadiusPx: 2,
  presets: {
    '1': { stroke: '#dc2626', fill: '#fee2e2' },
    '2': { stroke: '#ea580c', fill: '#ffedd5' },
    '3': { stroke: '#d97706', fill: '#fef3c7' },
    '4': { stroke: '#059669', fill: '#d1fae5' },
    '5': { stroke: '#0891b2', fill: '#cffafe' },
    '6': { stroke: '#9333ea', fill: '#f3e8ff' },
  },
  syntax: { keyword: '#7e22ce', string: '#047857', number: '#c2410c', comment: '#5b6472' },
  comment: {
    pin: { fill: '#d97706', stroke: '#ffffff' },
    bubble: { fill: '#ffffff', stroke: '#d97706' },
  },
  proposal: { edge: '#4f46e5', bubbleFill: '#ffffff' },
}

const SAMPLE_DARK: PaletteTokens = {
  node: {
    text: { fill: '#141414', stroke: '#d4d4d4' },
    file: { fill: '#1f1f1f', stroke: '#d4d4d4' },
    link: { fill: '#1f1f1f', stroke: '#d4d4d4' },
    group: { fill: 'none', stroke: '#d4d4d4' },
  },
  edgeStroke: '#d4d4d4',
  labelFill: '#ececec',
  surface: '#0a0a0a',
  cornerRadiusPx: 2,
  presets: {
    '1': { stroke: '#f87171', fill: '#450a0a' },
    '2': { stroke: '#fb923c', fill: '#431407' },
    '3': { stroke: '#fbbf24', fill: '#451a03' },
    '4': { stroke: '#34d399', fill: '#022c22' },
    '5': { stroke: '#22d3ee', fill: '#083344' },
    '6': { stroke: '#c084fc', fill: '#3b0764' },
  },
  syntax: { keyword: '#c084fc', string: '#34d399', number: '#fb923c', comment: '#9ba3af' },
  comment: {
    pin: { fill: '#fbbf24', stroke: '#0a0a0a' },
    bubble: { fill: '#262626', stroke: '#fbbf24' },
  },
  proposal: { edge: '#818cf8', bubbleFill: '#262626' },
}

/**
 * A complete, valid token bundle for tests in this package and in every
 * consumer — a fixture that satisfies the contract by construction, so a
 * test about registries or write validation never has to author a palette.
 */
export const SAMPLE_THEME_TOKENS: ThemeTokens = {
  ink: 'sketch',
  fontFamily: 'Patrick Hand',
  palette: { light: SAMPLE_LIGHT, dark: SAMPLE_DARK },
  defaults: { edgeRouting: 'curved' },
}
