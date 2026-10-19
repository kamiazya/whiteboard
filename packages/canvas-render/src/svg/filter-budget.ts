/**
 * A bound on the TOTAL raster work an SVG's filters ask for.
 *
 * A rasteriser allocates and blurs a layer the size of a filter's region for
 * every element that references it, so what an export costs is the SUM of
 * those regions. Each element's own region is already its own extent
 * (`glowOf`), and that bounds nothing in total: a corner-to-corner edge's
 * extent is the whole scene, and drop-shadowed comment bubbles stack, so a
 * few hundred elements ask for (elements) × (scene area) of blur.
 *
 * Past the budget the LARGEST regions lose their filter first, and their
 * filter definitions go with them — so a board under it, which is every
 * ordinary board, is returned as the very same tree and its bytes do not
 * move. What is dropped is decoration (a halo, a shadow), never ink.
 */

import type { BoundingBox } from '@kamiazya/whiteboard-scene'
import { collectDefs } from './defs.js'
import { DROP_SHADOW_ID } from './paint.js'
import { isVNode, type SvgChild, type SvgDef, type SvgVNode } from './vnode.js'

/**
 * The budget, in glow-equivalent DEVICE pixels of filter region, summed over
 * every referencing element and clipped to the drawn box. Measured with resvg
 * (`glow-export-cost.mjs`): a glow region costs about 270ms per megapixel,
 * and the worst boards it admits spent about 1.75s in resvg. A 150-node board
 * glowing under `visual.neon` sums about 6.2M at scale 1 and keeps all of it;
 * at 200 nodes (8.5M) its longest edges lose their halo first.
 */
const FILTER_REGION_BUDGET_PX = 8_000_000

/**
 * A drop shadow costs about twice what a glow does per pixel (550ms against
 * 270ms per megapixel on resvg — an offset, a flood and a composite on top of
 * the blur), so its pixels count twice against the same budget.
 */
const DROP_SHADOW_WEIGHT = 2

/** The specification's default filter region: -10%/-10%/120%/120% of the element. */
const DEFAULT_FRACTION = { x: -0.1, y: -0.1, w: 1.2, h: 1.2 } as const

const FILTER_REFERENCE = /^url\(#([^)]+)\)$/

interface Reference {
  readonly order: number
  readonly work: number
}

function clippedArea(region: BoundingBox, clip: BoundingBox): number {
  const w = Math.min(region.x + region.w, clip.x + clip.w) - Math.max(region.x, clip.x)
  const h = Math.min(region.y + region.h, clip.y + clip.h) - Math.max(region.y, clip.y)
  return w > 0 && h > 0 ? w * h : 0
}

function fraction(value: unknown, fallback: number): number {
  if (typeof value !== 'string' || !value.endsWith('%')) return fallback
  const parsed = Number(value.slice(0, -1)) / 100
  return Number.isFinite(parsed) ? parsed : fallback
}

const finite = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value)

/**
 * The region `def` declares when `element` references it. A region this
 * cannot read — a definition it does not hold, an element with no box — is
 * charged as the whole drawn box, so what cannot be measured is never free.
 */
function regionOf(element: SvgVNode, def: SvgDef | undefined, clip: BoundingBox): BoundingBox {
  const attrs = def?.node.attrs
  if (attrs === undefined) return clip
  if (attrs.filterUnits === 'userSpaceOnUse') {
    const { x, y, width, height } = attrs
    return finite(x) && finite(y) && finite(width) && finite(height)
      ? { x, y, w: width, h: height }
      : clip
  }
  const { x, y, width, height } = element.attrs ?? {}
  if (!(finite(x) && finite(y) && finite(width) && finite(height))) return clip
  return {
    x: x + fraction(attrs.x, DEFAULT_FRACTION.x) * width,
    y: y + fraction(attrs.y, DEFAULT_FRACTION.y) * height,
    w: fraction(attrs.width, DEFAULT_FRACTION.w) * width,
    h: fraction(attrs.height, DEFAULT_FRACTION.h) * height,
  }
}

function referencedId(node: SvgVNode): string | undefined {
  const filter = node.attrs?.filter
  return typeof filter === 'string' ? FILTER_REFERENCE.exec(filter)?.[1] : undefined
}

/** Every element carrying a filter, in document order (the order `strip` walks). */
function* filtered(children: ReadonlyArray<SvgChild>): Iterable<SvgVNode> {
  for (const child of children) {
    if (Array.isArray(child)) {
      yield* filtered(child)
    } else if (isVNode(child)) {
      if (referencedId(child) !== undefined) yield child
      yield* filtered(child.children ?? [])
    }
  }
}

/** `node` without its filter reference, or the definition of that filter. */
function unfiltered(node: SvgVNode, id: string): SvgVNode {
  const { filter: _filter, ...attrs } = node.attrs ?? {}
  const defs = (node.defs ?? []).filter((def) => !(def.id === id && def.node.tag === 'filter'))
  const { defs: _defs, ...rest } = node
  return { ...rest, attrs, ...(defs.length > 0 ? { defs } : {}) }
}

/** Rebuilds the tree with the filters at `drop`'s document-order positions removed. */
function strip(
  children: ReadonlyArray<SvgChild>,
  drop: ReadonlySet<number>,
  counter: { next: number },
): ReadonlyArray<SvgChild> {
  return children.map((child): SvgChild => {
    if (Array.isArray(child)) return strip(child, drop, counter)
    if (!isVNode(child)) return child
    let node = child
    const id = referencedId(node)
    if (id !== undefined && drop.has(counter.next++)) node = unfiltered(node, id)
    return node.children === undefined
      ? node
      : { ...node, children: strip(node.children, drop, counter) }
  })
}

/** A raster scale that is not a positive finite number draws at 1x. */
function sanitizeRasterScale(scale: number | undefined): number {
  return scale !== undefined && Number.isFinite(scale) && scale > 0 ? scale : 1
}

/**
 * `body` with its filter work held to `FILTER_REGION_BUDGET_PX` at
 * `rasterScale` device pixels per user unit, and the definitions what is
 * left references. `clip` is the drawn box: nothing outside it is
 * rasterised, so no region is charged past it.
 */
export function boundFilterWork(
  body: ReadonlyArray<SvgChild>,
  clip: BoundingBox,
  rasterScale: number | undefined,
): { readonly body: ReadonlyArray<SvgChild>; readonly defs: ReadonlyArray<SvgDef> } {
  const defs = collectDefs(body)
  const byId = new Map(defs.map((def) => [def.id, def]))
  const scale = sanitizeRasterScale(rasterScale)
  const deviceArea = scale * scale
  const references: Reference[] = []
  let total = 0
  for (const node of filtered(body)) {
    const id = referencedId(node)!
    const weight = id === DROP_SHADOW_ID ? DROP_SHADOW_WEIGHT : 1
    const work = weight * deviceArea * clippedArea(regionOf(node, byId.get(id), clip), clip)
    references.push({ order: references.length, work })
    total += work
  }
  if (total <= FILTER_REGION_BUDGET_PX) return { body, defs }

  // Largest first; among equals the later one, which paints over the earlier.
  const ranked = [...references].sort((a, b) => b.work - a.work || b.order - a.order)
  const drop = new Set<number>()
  for (const reference of ranked) {
    if (total <= FILTER_REGION_BUDGET_PX) break
    drop.add(reference.order)
    total -= reference.work
  }
  const bounded = strip(body, drop, { next: 0 })
  return { body: bounded, defs: collectDefs(bounded) }
}
