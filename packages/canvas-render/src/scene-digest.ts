import { z } from 'zod'
import type { BoundingBox, Scene } from './scene-graph.js'

/**
 * `sceneDigest`'s output is the ONLY Zod-schematized surface in this
 * package: it is the AI-facing spatial digest that crosses a process
 * boundary (the `/document/{id}/layout` route payload and the `canvas_layout`
 * MCP tool output), per this repo's zod-schema-discipline. Every array
 * below uses an explicit total sort with a documented tie-breaker — no
 * Set/Map iteration order is allowed to leak into the output, or the
 * AI-facing JSON would be non-reproducible across runs.
 */

const bboxSchema = z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() })

export const sceneDigestSchema = z.object({
  nodes: z.array(z.object({ id: z.string(), bbox: bboxSchema, z: z.number().int() })),
  overlaps: z.array(z.tuple([z.string(), z.string()])),
  containment: z.array(z.object({ parent: z.string(), child: z.string() })),
  clusters: z.array(z.array(z.string())),
  freeRegions: z.array(bboxSchema),
})

export type SceneDigest = z.infer<typeof sceneDigestSchema>

/** Two bboxes join the same proximity cluster when their gap is <= this, in px. */
const PROXIMITY_THRESHOLD_PX = 24
/** Grid granularity for free-region computation, in px. */
const FREE_REGION_GRID_PX = 20
/**
 * Upper bound on the occupancy grid's cell count. Scene coordinates are
 * caller-supplied and unbounded, so two distant boxes could otherwise size
 * an arbitrarily large `rows x cols` boolean matrix; past this bound free
 * regions are dropped rather than risking unbounded allocation.
 */
const FREE_REGION_MAX_CELLS = 250_000
/**
 * Upper bound on the entry count fed into the pairwise O(n^2)
 * overlap/containment/cluster derivation below. Scene node counts are
 * caller-supplied and unbounded, so past this bound each of the three
 * fields degrades to empty rather than risking a runaway pairwise scan —
 * mirroring FREE_REGION_MAX_CELLS's guard for the grid allocation above.
 */
const PAIRWISE_MAX_ENTRIES = 2_000

interface DigestEntry {
  readonly id: string
  readonly bbox: BoundingBox
  readonly z: number
}

function overlapArea(a: BoundingBox, b: BoundingBox): number {
  const width = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)
  const height = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)
  return width > 0 && height > 0 ? width * height : 0
}

function area(box: BoundingBox): number {
  return box.w * box.h
}

/**
 * A parent must be strictly larger in area than its child — an identical
 * bbox on two distinct nodes is overlap, not containment. Without this,
 * two equal-area boxes each qualify as the other's unique smallest
 * containing candidate, and computeContainment emits both directions,
 * a contradictory (non-antisymmetric) relation in the AI-facing digest.
 */
function contains(parent: BoundingBox, child: BoundingBox): boolean {
  return (
    child.x >= parent.x &&
    child.y >= parent.y &&
    child.x + child.w <= parent.x + parent.w &&
    child.y + child.h <= parent.y + parent.h &&
    area(parent) > area(child)
  )
}

function gapBetween(a: BoundingBox, b: BoundingBox): number {
  const dx = Math.max(a.x - (b.x + b.w), b.x - (a.x + a.w), 0)
  const dy = Math.max(a.y - (b.y + b.h), b.y - (a.y + a.h), 0)
  return Math.sqrt(dx * dx + dy * dy)
}

function computeOverlaps(entries: readonly DigestEntry[]): [string, string][] {
  if (entries.length > PAIRWISE_MAX_ENTRIES) return []
  const pairs: [string, string][] = []
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      if (overlapArea(entries[i].bbox, entries[j].bbox) > 0) {
        const [a, b] = [entries[i].id, entries[j].id].sort()
        pairs.push([a, b])
      }
    }
  }
  return pairs.sort(([a1, b1], [a2, b2]) =>
    a1 === a2 ? b1.localeCompare(b2) : a1.localeCompare(a2),
  )
}

function computeContainment(entries: readonly DigestEntry[]): { parent: string; child: string }[] {
  if (entries.length > PAIRWISE_MAX_ENTRIES) return []
  const result: { parent: string; child: string }[] = []
  for (const child of entries) {
    const candidates = entries.filter(
      (parent) => parent.id !== child.id && contains(parent.bbox, child.bbox),
    )
    if (candidates.length === 0) continue
    const smallest = [...candidates].sort((a, b) => {
      const areaDiff = area(a.bbox) - area(b.bbox)
      return areaDiff !== 0 ? areaDiff : a.id.localeCompare(b.id)
    })[0]
    result.push({ parent: smallest.id, child: child.id })
  }
  return result.sort((a, b) =>
    a.child === b.child ? a.parent.localeCompare(b.parent) : a.child.localeCompare(b.child),
  )
}

/** Single-linkage union-find clustering by proximity gap. */
function computeClusters(entries: readonly DigestEntry[]): string[][] {
  if (entries.length > PAIRWISE_MAX_ENTRIES) return []
  const parent = new Map<string, string>(entries.map((e) => [e.id, e.id]))
  function find(id: string): string {
    let current = id
    while (parent.get(current) !== current) {
      current = parent.get(current) as string
    }
    return current
  }
  function union(a: string, b: string): void {
    const rootA = find(a)
    const rootB = find(b)
    if (rootA !== rootB) parent.set(rootA, rootB)
  }

  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      if (gapBetween(entries[i].bbox, entries[j].bbox) <= PROXIMITY_THRESHOLD_PX) {
        union(entries[i].id, entries[j].id)
      }
    }
  }

  const groups = new Map<string, string[]>()
  for (const entry of entries) {
    const root = find(entry.id)
    const group = groups.get(root) ?? []
    group.push(entry.id)
    groups.set(root, group)
  }

  return [...groups.values()]
    .map((group) => [...group].sort((a, b) => a.localeCompare(b)))
    .sort((a, b) => a[0].localeCompare(b[0]))
}

/** Maximal empty axis-aligned rectangles over the union bounding box, on a fixed grid. */
function computeFreeRegions(entries: readonly DigestEntry[]): BoundingBox[] {
  if (entries.length === 0) return []

  const minX = Math.min(...entries.map((e) => e.bbox.x))
  const minY = Math.min(...entries.map((e) => e.bbox.y))
  const maxX = Math.max(...entries.map((e) => e.bbox.x + e.bbox.w))
  const maxY = Math.max(...entries.map((e) => e.bbox.y + e.bbox.h))

  const cols = Math.max(1, Math.ceil((maxX - minX) / FREE_REGION_GRID_PX))
  const rows = Math.max(1, Math.ceil((maxY - minY) / FREE_REGION_GRID_PX))
  if (cols * rows > FREE_REGION_MAX_CELLS) return []
  const occupied: boolean[][] = Array.from({ length: rows }, () => Array<boolean>(cols).fill(false))

  for (const entry of entries) {
    const c0 = Math.floor((entry.bbox.x - minX) / FREE_REGION_GRID_PX)
    // The right/bottom edges are exclusive, so a box ending exactly on a
    // grid line must not occupy the next cell: ceil(...) - 1 agrees with
    // floor(...) except exactly at a grid boundary, where it correctly
    // stops one cell earlier.
    const c1 = Math.ceil((entry.bbox.x + entry.bbox.w - minX) / FREE_REGION_GRID_PX) - 1
    const r0 = Math.floor((entry.bbox.y - minY) / FREE_REGION_GRID_PX)
    const r1 = Math.ceil((entry.bbox.y + entry.bbox.h - minY) / FREE_REGION_GRID_PX) - 1
    for (let r = r0; r <= Math.min(r1, rows - 1); r++) {
      for (let c = c0; c <= Math.min(c1, cols - 1); c++) {
        if (r >= 0 && c >= 0) occupied[r][c] = true
      }
    }
  }

  const regions: BoundingBox[] = []
  for (let r = 0; r < rows; r++) {
    let runStart = -1
    for (let c = 0; c <= cols; c++) {
      const isFree = c < cols && !occupied[r][c]
      if (isFree && runStart === -1) {
        runStart = c
      } else if (!isFree && runStart !== -1) {
        regions.push({
          x: minX + runStart * FREE_REGION_GRID_PX,
          y: minY + r * FREE_REGION_GRID_PX,
          w: (c - runStart) * FREE_REGION_GRID_PX,
          h: FREE_REGION_GRID_PX,
        })
        runStart = -1
      }
    }
  }

  return regions.sort((a, b) =>
    a.y === b.y ? (a.x === b.x ? (a.w === b.w ? a.h - b.h : a.w - b.w) : a.x - b.x) : a.y - b.y,
  )
}

/**
 * What the digest reports as a "node".
 *
 * When the scene came from a spatial canvas, that is exactly the chrome
 * shapes — the boxes a reader can address by id. Everything else with a
 * bbox is CONTENT laid out inside one of them (a node's text runs, a card's
 * rows), and reporting those alongside was actively misleading: a
 * three-node canvas answered with six entries, every one of which was
 * "contained in" another, and none of the extra three could be acted on.
 *
 * A scene with no identified shape at all is not a canvas projection — a
 * hand-built scene, a fragment — and keeps the previous behaviour of taking
 * every bbox-carrying node, named by position. There is nothing better to
 * name them by, and the alternative is answering with nothing.
 */
function collectEntries(scene: Scene): { readonly id?: string; readonly bbox: BoundingBox }[] {
  const identified = scene.nodes.flatMap((node) =>
    node.kind === 'shape' && node.id !== undefined ? [{ id: node.id, bbox: node.bbox }] : [],
  )
  if (identified.length > 0) return identified
  return scene.nodes.flatMap((node) => (node.kind === 'edge' ? [] : [{ bbox: node.bbox }]))
}

/**
 * Derives the AI-facing spatial digest from a laid-out scene: resolved
 * bboxes / z-order, overlap pairs, containment, proximity clusters, and
 * free regions. Pure function — same scene always yields the same digest,
 * in the same canonical order.
 */
export function sceneDigest(scene: Scene): SceneDigest {
  const entries: DigestEntry[] = collectEntries(scene).map((entry, index) => ({
    id: entry.id ?? `n${index}`,
    bbox: entry.bbox,
    z: index,
  }))

  return {
    nodes: entries.map((e) => ({ id: e.id, bbox: e.bbox, z: e.z })),
    overlaps: computeOverlaps(entries),
    containment: computeContainment(entries),
    clusters: computeClusters(entries),
    freeRegions: computeFreeRegions(entries),
  }
}
