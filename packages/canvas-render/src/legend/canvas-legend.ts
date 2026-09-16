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
import { parseScopedTag } from '@kamiazya/whiteboard-model'
import type { LegendEntry, LegendKey, LegendSwatch, SceneLegend } from '@kamiazya/whiteboard-scene'
import type { SpatialAppearanceResolver } from '../layout/nodes/spatial-appearance.js'
import { scoreFacets } from '../quality/facet-score.js'

interface Tagged {
  readonly id: string
  readonly tags?: readonly string[]
}

/** The value one element carries under `key`, or `''` — a carried key has at most one. */
function valueUnder(element: Tagged, key: string): string {
  for (const tag of element.tags ?? []) {
    const scoped = parseScopedTag(tag)
    if (scoped?.key === key) return scoped.value
  }
  return ''
}

function isTagKey(elements: readonly Tagged[], key: string): boolean {
  return elements.some((element) =>
    (element.tags ?? []).some((tag) => parseScopedTag(tag)?.key === key),
  )
}

function entriesFor<T extends Tagged>(
  elements: readonly T[],
  key: string,
  swatchOf: (element: T) => LegendSwatch,
): LegendEntry[] {
  const classes = new Map<string, { count: number; swatch: LegendSwatch }>()
  for (const element of elements) {
    const value = valueUnder(element, key)
    const seen = classes.get(value)
    // Constant within the class — that is what `carried` means — so the
    // first member's swatch is the class's.
    classes.set(value, { count: (seen?.count ?? 0) + 1, swatch: seen?.swatch ?? swatchOf(element) })
  }
  // Values in code-unit order, the untagged class last: a reader scans the
  // named values first and the remainder is what is left.
  return [...classes]
    .sort(([a], [b]) => (a === '' ? 1 : b === '' ? -1 : a < b ? -1 : a > b ? 1 : 0))
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

export function canvasLegend(
  canvas: SpatialCanvas,
  appearance: SpatialAppearanceResolver,
): SceneLegend | undefined {
  const score = scoreFacets(canvas)
  const boxes = canvas.nodes.filter((node) => node.type !== 'group')
  const keys: LegendKey[] = [
    ...score.channels.colour.carriedBy
      .filter((key) => isTagKey(boxes, key))
      .map((key) => ({
        key,
        of: 'boxes' as const,
        entries: entriesFor(boxes, key, (node) => boxSwatch(appearance, node)),
      })),
    ...score.edges.colour.carriedBy
      .filter((key) => isTagKey(canvas.edges, key))
      .map((key) => ({
        key,
        of: 'edges' as const,
        entries: entriesFor(canvas.edges, key, (edge) => edgeSwatch(appearance, edge)),
      })),
  ]
  const uncarried = {
    boxes: score.channels.colour.use === 'contested',
    edges: score.edges.colour.use === 'contested',
  }
  if (keys.length === 0 && !uncarried.boxes && !uncarried.edges) return undefined
  return { keys, uncarried }
}
