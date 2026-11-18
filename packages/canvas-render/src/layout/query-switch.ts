import type { SpatialCanvas, SpatialNode } from '@kamiazya/whiteboard-model'
import type { SceneNode } from '@kamiazya/whiteboard-scene'
import type { CoreSvgAsk } from '../canvas-core.js'
import { measureSpecOf } from '../measure.js'
import type { QueryNumbers } from '../query-core.js'
import { type SceneDigest, sceneDigestSchema } from '../scene-digest-schema.js'
import { SPATIAL_THEME_GEOMETRY } from '../theme/spatial-geometry.js'
import { bundledThemeModeOf } from '../theme/spatial-theme.js'
import { askedPicture, type MaybePictured } from './asked-picture.js'
import { CoreUnaskable, canvasLayoutRequest, hostEvent, styleOptions } from './canvas-switch.js'
import { type Answered, queried } from './core-query.js'
import type { SpatialLayoutOptions } from './layout-options.js'

// The layout pieces a root calls on their own, through the Rust core's query
// entry (ADR-0054 step 7, S18d): the request each makes, and what it is
// answered with. Handed a core, the core answers, and a query it refused is
// answered as the query itself says (`unanswered`), since there
// is no TypeScript behind it any more (S18g); handed none, the TypeScript does.

/** The numbers of a query's answer, or undefined when it answered an edge layer. */
export const numbersOf = (answer: Answered): readonly QueryNumbers[] | undefined =>
  'numbers' in answer ? answer.numbers : undefined

/** A list of exactly `n` numbers, or undefined. */
export function tupleOf(value: QueryNumbers | undefined, n: number): number[] | undefined {
  if (!Array.isArray(value) || value.length !== n) return undefined
  return value.every((v) => typeof v === 'number') ? (value as number[]) : undefined
}

/**
 * The drag frame's edge layer through `options.core`'s query entry
 * (`layoutSpatialEdges`): the request is the canvas layout's own, so the core
 * answers it exactly as it answers the whole layout, and its degradations reach
 * `onDegrade`. A layer the core refused is no edges: the whole layout of the
 * same request was refused too, and the surface draws its refusal instead.
 */
export function edgesThroughCore(
  stored: SpatialCanvas,
  options: SpatialLayoutOptions,
): SceneNode[] {
  return edgeLayerThroughCore(stored, options, undefined).nodes
}

/**
 * `edgesThroughCore` with the picture the core drew of the layer, as a scene
 * of its own, in the envelope and form `svg` names when it asks for one; none
 * for a layer the core refused, which is no edges.
 */
export function edgeLayerThroughCore(
  stored: SpatialCanvas,
  options: SpatialLayoutOptions,
  svg: CoreSvgAsk | undefined,
): { readonly nodes: SceneNode[] } & MaybePictured {
  const unanswered = { nodes: [] as readonly SceneNode[] }
  const layer = queried<{ readonly nodes: readonly SceneNode[] } & MaybePictured>(options.core, {
    request: () => {
      const request = { ...canvasLayoutRequest(stored, options), query: 'edges' as const }
      return svg === undefined ? request : { ...request, svg }
    },
    unanswered: () => unanswered,
    read: (answer) => {
      if (!('nodes' in answer)) return undefined
      for (const event of answer.degradations) options.onDegrade?.(hostEvent(event))
      const nodes = answer.nodes
      return svg === undefined ? { nodes } : { nodes, ...askedPicture(svg, answer) }
    },
    measure: options.measure,
  })
  return { ...layer, nodes: [...layer.nodes] }
}

/** What a digest says when nothing could be derived: a fresh one each time, so a caller's edit never reaches the next refusal. */
const emptyDigest = (): SceneDigest => ({
  nodes: [],
  overlaps: [],
  containment: [],
  clusters: [],
  freeRegions: [],
  partial: true,
})

/**
 * The spatial digest of the scene `stored` lays out, through `options.core`'s
 * query entry: the core digests the scene where it lays it out, so the scene
 * is never sent back. The text it writes is held to `sceneDigestSchema`. A
 * layout the core refused has no scene to digest, and is answered as a digest
 * that says so (`partial`, nothing derived) beside the refusal `onRefused`
 * hears, which the same request's drawn layout would show.
 */
export function layoutSceneDigest(
  stored: SpatialCanvas,
  options: SpatialLayoutOptions,
): SceneDigest {
  return queried<SceneDigest>(options.core, {
    request: () => ({ ...canvasLayoutRequest(stored, options), query: 'scene-digest' }),
    unanswered: (refused) => {
      options.onRefused?.(refused)
      return emptyDigest()
    },
    read: (answer) => {
      if (!('digest' in answer)) return undefined
      for (const event of answer.degradations) options.onDegrade?.(hostEvent(event))
      return sceneDigestSchema.parse(JSON.parse(answer.digest))
    },
    measure: options.measure,
  })
}

/** The options a node's natural size reads that the core's query takes as data. */
const NATURAL_OPTIONS = new Set([
  'measure',
  'appearance',
  'style',
  'fontAvailable',
  'fragments',
  'core',
])

/**
 * A node's natural content size through `options.core`'s query entry
 * (`naturalNodeContentSize`). The core's query takes the measurer, the theme
 * mode, the style with the families the surface holds, and a fragment table;
 * an option beyond those is `CoreUnaskable`. A size the core refused is what
 * the node's own box holds inside its padding, so a caller sizing the node by
 * it leaves the node as it is.
 */
export function naturalSizeThroughCore(
  node: SpatialNode,
  options: Pick<SpatialLayoutOptions, 'measure' | 'appearance' | 'core'> &
    Partial<Pick<SpatialLayoutOptions, 'style' | 'fontAvailable' | 'fragments'>>,
): { readonly w: number; readonly h: number } {
  return queried(options.core, {
    request: () => {
      const measure = measureSpecOf(options.measure)
      const mode = bundledThemeModeOf(options.appearance)
      if (mode === undefined) throw new CoreUnaskable('appearance')
      const set = Object.entries(options).filter(([, value]) => value !== undefined)
      const extra = set.find(([key]) => !NATURAL_OPTIONS.has(key))
      if (extra !== undefined) throw new CoreUnaskable(`option:${extra[0]}`)
      const { fragments } = options
      return {
        query: 'node-content',
        node,
        measure,
        mode,
        ...styleOptions(options),
        ...(fragments === undefined ? {} : { fragments }),
      }
    },
    unanswered: () => {
      const inset = 2 * SPATIAL_THEME_GEOMETRY.paddingPx
      return { w: Math.max(0, node.width - inset), h: Math.max(0, node.height - inset) }
    },
    read: (answer) => {
      const [size] = numbersOf(answer) ?? []
      const wh = tupleOf(size, 2)
      return wh === undefined ? undefined : { w: wh[0] as number, h: wh[1] as number }
    },
    measure: options.measure,
  })
}
