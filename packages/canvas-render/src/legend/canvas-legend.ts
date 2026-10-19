/**
 * The board's legend ([ADR-0040](../../../../docs/contributing/adr/0040-scoped-tags.md)
 * decision 6), derived from the facet score so it can only ever name a
 * distinction the drawing keeps: a key is listed when the score reads the
 * population's colour as `carried` by it, and every value's swatch is the
 * colour its class is drawn in, resolved by the same appearance the layout
 * paints with. A key colour is carried by that is not a scoped tag — a
 * frame, a kind, a stencil — has no values a legend can name and is not
 * listed. When colour is spent and no key carries it, the legend says so in
 * one line rather than inventing a key.
 */
import type { CanvasEdge, SpatialCanvas, SpatialNode } from '@kamiazya/whiteboard-model'
import { compareCodeUnit, isFrame, parseScopedTag } from '@kamiazya/whiteboard-model'
import type { LegendEntry, LegendKey, LegendSwatch, SceneLegend } from '@kamiazya/whiteboard-scene'
import { scoreFacets } from '../quality/facet-score.js'
import type { SpatialAppearanceResolver } from '../theme/spatial-appearance.js'

interface Tagged {
  readonly id: string
  readonly tags?: readonly string[]
}

/**
 * Each element's scoped tags as key -> value, read once. A carried key has at
 * most one value per element; where an element writes two, the first wins,
 * since the legend only lists keys the score found to be a partition.
 * Built once per population so the legend costs one pass over the tags
 * however many keys colour is carried by.
 */
function scopedTagsOf<T extends Tagged>(elements: readonly T[]): Map<T, Map<string, string>> {
  const byElement = new Map<T, Map<string, string>>()
  for (const element of elements) {
    const values = new Map<string, string>()
    for (const tag of element.tags ?? []) {
      const scoped = parseScopedTag(tag)
      if (scoped !== undefined && !values.has(scoped.key)) values.set(scoped.key, scoped.value)
    }
    byElement.set(element, values)
  }
  return byElement
}

function keysOf(scoped: ReadonlyMap<unknown, ReadonlyMap<string, string>>): Set<string> {
  const keys = new Set<string>()
  for (const values of scoped.values()) for (const key of values.keys()) keys.add(key)
  return keys
}

function entriesFor<T extends Tagged>(
  elements: readonly T[],
  scoped: ReadonlyMap<T, ReadonlyMap<string, string>>,
  key: string,
  swatchOf: (element: T) => LegendSwatch,
): LegendEntry[] {
  const classes = new Map<string, { count: number; swatch: LegendSwatch }>()
  for (const element of elements) {
    const value = scoped.get(element)?.get(key) ?? ''
    const seen = classes.get(value)
    // Constant within the class — that is what `carried` means — so the
    // first member's swatch is the class's.
    classes.set(value, { count: (seen?.count ?? 0) + 1, swatch: seen?.swatch ?? swatchOf(element) })
  }
  // Values in code-unit order, the untagged class last: a reader scans the
  // named values first and the remainder is what is left.
  return [...classes]
    .sort(([a], [b]) => (a === '' ? 1 : b === '' ? -1 : compareCodeUnit(a, b)))
    .map(([value, { count, swatch }]) => ({ value, count, swatch }))
}

function boxSwatch(appearance: SpatialAppearanceResolver, node: SpatialNode): LegendSwatch {
  const resolved = appearance.resolveNode(node).appearance
  return {
    ...(resolved?.fill === undefined ? {} : { fill: resolved.fill }),
    ...(resolved?.stroke === undefined ? {} : { stroke: resolved.stroke }),
  }
}

function edgeSwatch(appearance: SpatialAppearanceResolver, edge: CanvasEdge): LegendSwatch {
  const stroke = appearance.resolveEdge(edge)?.stroke
  return stroke === undefined ? {} : { stroke }
}

/** The keys of `carriedBy` that are scoped tags of this population, each with its values. */
function legendKeys<T extends Tagged>(
  elements: readonly T[],
  carriedBy: readonly string[],
  of: LegendKey['of'],
  swatchOf: (element: T) => LegendSwatch,
): LegendKey[] {
  if (carriedBy.length === 0) return []
  const scoped = scopedTagsOf(elements)
  const tagKeys = keysOf(scoped)
  return carriedBy
    .filter((key) => tagKeys.has(key))
    .map((key) => ({ key, of, entries: entriesFor(elements, scoped, key, swatchOf) }))
}

export function canvasLegend(
  canvas: SpatialCanvas,
  appearance: SpatialAppearanceResolver,
): SceneLegend | undefined {
  const score = scoreFacets(canvas)
  const boxes = canvas.nodes.filter((node) => !isFrame(node))
  const keys: LegendKey[] = [
    ...legendKeys(boxes, score.channels.colour.carriedBy, 'boxes', (node) =>
      boxSwatch(appearance, node),
    ),
    ...legendKeys(canvas.edges, score.edges.colour.carriedBy, 'edges', (edge) =>
      edgeSwatch(appearance, edge),
    ),
  ]
  const uncarried = {
    boxes: score.channels.colour.use === 'contested',
    edges: score.edges.colour.use === 'contested',
  }
  if (keys.length === 0 && !uncarried.boxes && !uncarried.edges) return undefined
  return { keys, uncarried }
}
