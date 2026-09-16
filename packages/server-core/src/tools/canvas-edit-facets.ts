/**
 * Applying FACETS to a node a `wb_canvas_edit` batch is about to keep — the
 * inline write path for a box's second axis, beside `dressWithStencil` for
 * its first.
 *
 * Its own module for the reason the stencil helper is: `canvas-edit.ts` is
 * past the shrink-only file-size budget. Nothing here closes over the batch.
 */

import type { FacetRegistry } from '@kamiazya/whiteboard-facet-engine'
import type { SpatialNode } from '@kamiazya/whiteboard-model'
import { CanvasEditError } from './canvas-edit-error.js'
import { dressWithStencil } from './canvas-edit-stencil.js'

/**
 * Everything one op may DRESS a box with, gathered so the two call sites in
 * `canvas-edit.ts` are each one line — that file is past the shrink-only
 * size budget, and the budget is what keeps a new feature from being
 * paid for by the ceiling rather than by a seam.
 */
export interface Dressing {
  readonly stencil?: string
  /** The colour THIS op named, which wins over a stencil's — see `dressWithStencil`. */
  readonly color?: string
  readonly facets?: Readonly<Record<string, unknown>>
}

/** Stencil first, then facets, so a classification sits beside what the stencil recorded. */
export function dressNode(
  index: number,
  opName: string,
  node: SpatialNode,
  dressing: Dressing,
  registry: FacetRegistry,
): SpatialNode {
  const dressed = dressWithStencil(index, opName, node, dressing.stencil, dressing.color, registry)
  return dressWithFacets(index, opName, dressed, dressing.facets, registry)
}

/** `dressNode` over a selection; untouched when the op dresses nothing. */
export function dressSelected(
  index: number,
  opName: string,
  nodes: readonly SpatialNode[],
  ids: readonly string[],
  dressing: Dressing,
  registry: FacetRegistry,
): SpatialNode[] {
  if (dressing.stencil === undefined && dressing.facets === undefined) return [...nodes]
  return nodes.map((n) =>
    ids.includes(n.id) ? dressNode(index, opName, n, dressing, registry) : n,
  )
}

/**
 * Validates exactly as `wb_facet_set` does — declared targets first, then the
 * facet's own schema — and merges by key: an omitted key keeps its stored
 * value, `null` deletes. A registered facet that refuses fails the WHOLE
 * batch, as an unknown stencil does, and for the same reason: a box that
 * silently kept a wrong or missing classification is a drawing claiming a
 * distinction it does not record. An unregistered key passes through
 * unvalidated on both paths, so a payload written by a plugin this
 * deployment lacks survives a re-write.
 */
function dressWithFacets(
  index: number,
  opName: string,
  node: SpatialNode,
  facets: Readonly<Record<string, unknown>> | undefined,
  registry: FacetRegistry,
): SpatialNode {
  if (facets === undefined) return node
  const merged: Record<string, unknown> = { ...(node.facets ?? {}) }
  for (const [key, payload] of Object.entries(facets)) {
    if (payload === null) {
      delete merged[key]
      continue
    }
    const targets = registry.targetsOf(key)
    if (targets !== undefined && !targets.includes('node')) {
      throw new CanvasEditError(
        index,
        opName,
        `facet "${key}" rejected: its targets are [${targets.join(', ')}], and this write targets a node`,
      )
    }
    const result = registry.validateFacetWrite(key, payload)
    if (!result.ok)
      throw new CanvasEditError(index, opName, `facet "${key}" rejected: ${result.message}`)
    merged[key] = result.value
  }
  // An empty bucket is omitted, not stored as `{}`: stored buckets never
  // hold nothing, and the two would differ on the wire for no reason.
  const { facets: _dropped, ...rest } = node
  return Object.keys(merged).length === 0 ? (rest as SpatialNode) : { ...rest, facets: merged }
}
