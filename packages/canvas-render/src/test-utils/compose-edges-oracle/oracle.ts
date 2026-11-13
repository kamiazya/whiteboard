import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import {
  resolveCanvasEdgeStyle,
  resolveEdgeOwnStyle,
  resolveStrokeWidth,
  VISUAL_THEMES,
} from '@kamiazya/whiteboard-plugin-visual'
import type { ResolvedEdgeNode, RoutableElement, SceneNode } from '@kamiazya/whiteboard-scene'
import { computeEdgeJumps } from '../../layout/edges/edge-jumps.js'
import type { EdgeAnchorPair } from '../../layout/edges/edge-sides.js'
import type { ResolvedLayoutOptions } from '../../layout/layout-options.js'
import { BUNDLED_SHAPE_TABLE } from '../../layout/nodes/node-outline.js'
import { composeEdgesAndLabels } from '../../layout/spatial-canvas.js'
import type { FontDescriptor, TextMetrics } from '../../measure.js'
import { createSpatialTheme } from '../../theme/spatial-theme.js'
import { createThemedAppearance } from '../../theme/theme-asset.js'
import { createFakeMeasure } from '../fake-measure.js'
import { dumpScene, f64Hex } from '../render-oracle/scene-dump.js'
import { type Board, boards, GEOMETRIES, THEMES, type ThemeName } from './corpus.js'
import { canvasWire, type Facts, factsOf, overridesWire, type Wire } from './wire.js'

/**
 * The recorded answers of the edge pass (`composeEdgesAndLabels` in
 * `layout/spatial-canvas.ts`): every edge and line routed, weighed, pulled onto
 * the silhouettes of its ends and labelled, and the anchors the routing settled.
 *
 * What the Rust port takes as a seam is part of the case, as data: what the
 * plugin's facet readers answer for the canvas and for each element, and what
 * `computeEdgeJumps` answers for the routed edges. Every double is the hex of
 * its IEEE bits (a NaN the canonical one), and `calls` counts what the
 * measurer was asked.
 */

const tokensOf = (name: 'sketch' | 'neon') => {
  const tokens = VISUAL_THEMES[name]
  if (tokens === undefined)
    throw new Error(`compose-edges-oracle: the bundled ${name} theme is missing`)
  return tokens
}

/** `f64Hex`, with every NaN written as the positive quiet NaN `f64::NAN` is. */
export const hex = (value: number): string =>
  Number.isNaN(value) ? '7ff8000000000000' : f64Hex(value)

const FAMILY = { sketch: 'Yomogi', neon: 'Roboto' } as const

const appearanceOf = (theme: ThemeName) =>
  theme === 'light' || theme === 'dark'
    ? createSpatialTheme({ mode: theme })
    : createThemedAppearance({ tokens: tokensOf(theme), mode: 'light', fontFamily: FAMILY[theme] })

interface MetaRecord {
  readonly kind: 'meta'
  readonly sketch: unknown
  readonly neon: unknown
}

interface CaseRecord extends Wire {
  readonly kind: 'case'
  readonly id: string
  readonly theme: ThemeName
  readonly geometry: readonly string[]
  readonly facts: Facts
  readonly answer: Answer
}

interface Answer {
  readonly scene: string
  /** The anchors, in the order the routing settled them; every number as its hex. */
  readonly anchors: readonly (readonly (string | null)[])[]
  /** What `computeEdgeJumps` answers for the routed edges, when any element hops. */
  readonly jumps: readonly (readonly [string, readonly (readonly string[])[]])[] | null
  readonly calls: number
}

export type ComposeEdgesRecord = MetaRecord | CaseRecord

const pointHex = (p: { x: number; y: number } | undefined) =>
  p === undefined ? [null, null] : [hex(p.x), hex(p.y)]
const optionalHex = (v: number | undefined) => (v === undefined ? null : hex(v))

function anchorRow(id: string, a: EdgeAnchorPair): (string | null)[] {
  return [
    id,
    ...pointHex(a.from),
    ...pointHex(a.to),
    optionalHex(a.fromLaneDepth),
    optionalHex(a.toLaneDepth),
    a.fromSide ?? null,
    a.toSide ?? null,
    a.around === true ? 'around' : null,
  ]
}

/** The options a composer hands the edge pass for a board under a theme. */
function optionsOf(board: Board, theme: ThemeName, geometry: readonly number[], count: () => void) {
  const base = createFakeMeasure()
  const measure = (text: string, font: FontDescriptor): TextMetrics => {
    count()
    return base(text, font)
  }
  const [paddingPx, labelFontSizePx, minContentWidthPx] = geometry as [number, number, number]
  const themed = theme === 'sketch' || theme === 'neon'
  return {
    measure,
    appearance: appearanceOf(theme),
    geometry: { paddingPx, labelFontSizePx, minContentWidthPx },
    fitToBox: true,
    nodeOutlines: Object.keys(board.shapes).length === 0 ? undefined : board.shapes,
    shapeTable: BUNDLED_SHAPE_TABLE,
    contributions: [],
    ...(themed ? { activeTheme: { id: `visual.${theme}`, tokens: tokensOf(theme) } } : {}),
    ...(board.overrides === undefined ? {} : { edgeSideOverrides: new Map(board.overrides) }),
  } as unknown as ResolvedLayoutOptions
}

/**
 * What `computeEdgeJumps` was handed: the composed edges before any hop was put
 * on them, which is the drawn edges with their `jumps` taken off again.
 */
function jumpsOf(content: readonly SceneNode[], hops: boolean): Answer['jumps'] {
  if (!hops) return null
  const routed = content.flatMap((node) => {
    if (node.kind !== 'edge') return []
    const { jumps: _drawn, ...edge } = node
    return [edge as ResolvedEdgeNode]
  })
  return [...computeEdgeJumps(routed)].map(([id, points]) => [
    id,
    points.map((p) => [hex(p.segment), hex(p.x), hex(p.y)]),
  ])
}

/** Whether any element hops, by the same reading the edge pass makes. */
function anyHops(canvas: SpatialCanvas): boolean {
  const board = resolveCanvasEdgeStyle(canvas).lineJumps
  const own = new Map<string, string | undefined>()
  const routable: RoutableElement[] = [...canvas.edges, ...(canvas.lines ?? [])]
  return routable.some((element) => {
    if (!own.has(element.id)) own.set(element.id, resolveEdgeOwnStyle(element).lineJumps)
    return (own.get(element.id) ?? board ?? 'none') === 'arc'
  })
}

function caseRecord(board: Board, theme: ThemeName, geometry: readonly number[]): CaseRecord {
  let calls = 0
  const options = optionsOf(board, theme, geometry, () => {
    calls += 1
  })
  const { content, anchors } = composeEdgesAndLabels(board.canvas, options)
  const answer: Answer = {
    scene: dumpScene({ nodes: [...content] }, hex),
    anchors: [...anchors].map(([id, pair]) => anchorRow(id, pair)),
    jumps: jumpsOf(content, anyHops(board.canvas)),
    calls,
  }
  return {
    kind: 'case',
    id: `${board.name}/${theme}/${geometry.join('-')}`,
    theme,
    geometry: geometry.map(hex),
    ...canvasWire(board, hex),
    ...overridesWire(board, hex),
    facts: factsOf(board.canvas, resolveCanvasEdgeStyle, resolveEdgeOwnStyle, resolveStrokeWidth),
    answer,
  }
}

/** Every record, in file order: the meta line, then each board under each theme and geometry. */
export function composeEdgesRecords(): readonly ComposeEdgesRecord[] {
  const meta: MetaRecord = { kind: 'meta', sketch: tokensOf('sketch'), neon: tokensOf('neon') }
  const cases = boards().flatMap((board) =>
    THEMES.flatMap((theme) => GEOMETRIES.map((geometry) => caseRecord(board, theme, geometry))),
  )
  return [meta, ...cases]
}
