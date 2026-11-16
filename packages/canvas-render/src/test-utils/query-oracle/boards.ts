import {
  type CanvasEdge,
  isFrame,
  type SpatialCanvas,
  type SpatialNode,
} from '@kamiazya/whiteboard-model'
import { groupNode, textNode } from '@kamiazya/whiteboard-model/test-utils'
import type { Scene } from '@kamiazya/whiteboard-scene'
import type { EdgeAnchorOverride, EdgeAnchorPair } from '../../layout/edges/edge-sides.js'
import type { SpatialLayoutOptions } from '../../layout/layout-options.js'
import { layoutSpatialCanvasWithAnchors } from '../../layout/spatial-canvas.js'
import { createSpatialTheme } from '../../theme/spatial-theme.js'
import { boards, TAG_LIBRARY } from '../compose-canvas-oracle/corpus.js'
import { DRAWING_CORPUS } from '../drawing-corpus.js'
import { createFakeMeasure } from '../fake-measure.js'
import { ROUTING_CORPUS, stackedFrameLayouts, syntheticLayouts } from '../routing-corpus.js'
import { testLayoutCore } from '../test-layout-core.js'

/**
 * The boards the query recordings (ADR-0054 step 7, S18a) are drawn over,
 * each with an edge, and the editor's view of one: the options its drag
 * layers and label editors hand canvas-render (apps/web's `editorLayoutBase`
 * restated as data — the app theme, `style: 'document'`, the families the
 * realm holds, the workspace's tag library), and the committed layout a
 * gesture starts from.
 */

export interface EditorProfile {
  readonly mode: 'light' | 'dark'
  /** The families `fontAvailable` answers yes for. */
  readonly fonts: readonly string[]
  /** Whether the workspace's tag library is handed. */
  readonly library?: true
}

export const viaJson = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

export function editorOptions(profile: EditorProfile): SpatialLayoutOptions {
  const fonts = new Set(profile.fonts)
  return {
    core: testLayoutCore(),
    measure: createFakeMeasure(),
    appearance: createSpatialTheme({ mode: profile.mode }),
    style: 'document',
    fontAvailable: (family) => fonts.has(family),
    ...(profile.library === true ? { tagLibrary: TAG_LIBRARY } : {}),
  }
}

/** The editor profiles, cycled over the boards so each board is drawn under one. */
const PROFILES: readonly EditorProfile[] = [
  { mode: 'light', fonts: [] },
  { mode: 'dark', fonts: ['Yomogi'], library: true },
  { mode: 'light', fonts: ['Yomogi'], library: true },
]

const tagged = (canvas: SpatialCanvas): boolean =>
  [...canvas.nodes, ...canvas.edges].some((element) => (element.tags ?? []).length > 0)

/**
 * The profile the `index`th board is drawn under: the cycle, except that a
 * board carrying a tag is always handed the library, or the colour by intent
 * the drag layers apply would never be exercised.
 */
export function profileFor(canvas: SpatialCanvas, index: number): EditorProfile {
  const cycled = PROFILES[index % PROFILES.length] as EditorProfile
  return tagged(canvas) ? { ...cycled, library: true } : cycled
}

const box = (id: string, x: number, y: number, text: string) =>
  textNode({ id, x, y, width: 160, height: 70, text })

const link = (id: string, from: string, to: string, label?: string): CanvasEdge =>
  ({
    id,
    from: { node: from },
    to: { node: to, end: 'arrow' },
    ...(label === undefined ? {} : { label }),
  }) as CanvasEdge

/**
 * Crossing labelled edges under a frame's title, drawn in a themed look:
 * curved with arcs at the crossings in the sketch theme, orthogonal in neon.
 * No corpus board draws a curve or a jump under a theme.
 */
function crossings(theme: string, routing: string): SpatialCanvas {
  return {
    facets: {
      'visual.theme/v0': { theme },
      'visual.edges/v0': { routing, lineJumps: 'arc' },
    },
    nodes: [
      groupNode({ id: 'frame', x: -40, y: -60, width: 760, height: 420, label: 'Request path' }),
      box('w', 0, 120, 'West'),
      box('e', 520, 120, 'East'),
      box('n', 260, 0, 'North'),
      box('s', 260, 260, 'South'),
      box('c', 900, 120, '中央'),
    ],
    edges: [
      { ...link('we', 'w', 'e', 'across'), tags: ['health:failing'] },
      { ...link('ns', 'n', 's', 'down the middle'), tags: ['health:ok'] },
      link('wn', 'w', 'n'),
      link('ec', 'e', 'c', 'out of the frame'),
      link('sc', 's', 'c'),
    ],
  }
}

export interface QueryBoard {
  readonly name: string
  readonly canvas: SpatialCanvas
}

/** Every corpus board with an edge, as JSON reads it back. */
export function queryBoards(): readonly QueryBoard[] {
  const of = (nodes: readonly SpatialNode[], edges: readonly CanvasEdge[]): SpatialCanvas => ({
    nodes: [...nodes],
    edges: [...edges],
  })
  return [
    { name: 'hand/curved sketch', canvas: crossings('visual.sketch', 'curved') },
    { name: 'hand/orthogonal neon', canvas: crossings('visual.neon', 'orthogonal') },
    ...boards().map((b) => ({ name: `composer/${b.name}`, canvas: b.canvas })),
    ...DRAWING_CORPUS.map((c) => ({ name: `drawing/${c.name}`, canvas: c.canvas })),
    ...ROUTING_CORPUS.map((c) => ({ name: `routing/${c.name}`, canvas: of(c.nodes, c.edges) })),
    ...syntheticLayouts(4).map((c) => ({
      name: `routing/${c.name}`,
      canvas: of(c.nodes, c.edges),
    })),
    ...stackedFrameLayouts(2).map((c) => ({
      name: `routing/frames ${c.name}`,
      canvas: of(c.nodes, c.edges),
    })),
  ]
    .filter((b) => b.canvas.edges.length > 0)
    .map((b) => ({ name: b.name, canvas: viaJson(b.canvas) }))
}

/** What a gesture starts from: the committed scene and the anchors its edges were drawn with. */
export function committed(
  canvas: SpatialCanvas,
  profile: EditorProfile,
): { scene: Scene; anchors: ReadonlyMap<string, EdgeAnchorPair> } {
  return layoutSpatialCanvasWithAnchors(canvas, editorOptions(profile))
}

/** The node a drag carries: the first box an edge touches. */
export function draggedNode(canvas: SpatialCanvas): SpatialNode | undefined {
  const touched = new Set(canvas.edges.flatMap((e) => [e.from.node, e.to.node]))
  return canvas.nodes.find((n) => !isFrame(n) && touched.has(n.id))
}

/**
 * The overrides the drag layers hand `layoutSpatialEdges`, as apps/web's
 * `gesture-view.ts` builds them: every edge the gesture does not carry held
 * at its committed sides, anchors, lane depths and detour; with `cached`,
 * the carried edges pinned at their committed sides too, as a frame between
 * two re-siding steps reuses them.
 */
export function dragOverrides(
  scene: Scene,
  anchors: ReadonlyMap<string, EdgeAnchorPair>,
  carried: ReadonlySet<string>,
  cached: boolean,
): (readonly [string, EdgeAnchorOverride])[] {
  const out: (readonly [string, EdgeAnchorOverride])[] = []
  for (const node of scene.nodes) {
    if (node.kind !== 'edge') continue
    const sides = { fromSide: node.fromSide, toSide: node.toSide }
    if (carried.has(node.id)) {
      if (cached) out.push([node.id, sides])
      continue
    }
    const pin = anchors.get(node.id)
    out.push([
      node.id,
      {
        ...sides,
        ...(pin?.from === undefined ? {} : { from: pin.from }),
        ...(pin?.fromLaneDepth === undefined ? {} : { fromLaneDepth: pin.fromLaneDepth }),
        ...(pin?.to === undefined ? {} : { to: pin.to }),
        ...(pin?.toLaneDepth === undefined ? {} : { toLaneDepth: pin.toLaneDepth }),
        ...(pin?.around === true ? { around: true as const } : {}),
      },
    ])
  }
  return out
}
