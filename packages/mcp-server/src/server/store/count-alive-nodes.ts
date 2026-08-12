import { readSpatialCanvas } from '@kamiazya/whiteboard-canvas-workspace'
import type { LoroDoc } from 'loro-crdt'

// Shared "how many elements does this doc have" reader for the daemon's
// advisory UI counts (History panel / restore response / /api/debug).
//
// - Edges are excluded: the bridge's edge-cascade invariant (an edge is
//   deleted whenever either endpoint node is removed) means an edge can
//   never outlive both of its nodes, so a nodes-only count is never 0 for
//   a non-empty scene.
// - The legacy 'elements' movable-list walk is a FALLBACK, not an additive
//   pass — summing both would double-count a doc mid-migration with both
//   shapes populated. Falling back only when the nodes map is empty keeps
//   a pre-migration doc's real count without ever consulting stale legacy
//   entries on a migrated doc.
export function countAliveNodes(doc: LoroDoc): number {
  const { nodes } = readSpatialCanvas(doc)
  if (nodes.length > 0) return nodes.length

  const list = doc.getMovableList('elements').toJSON() as Array<{ isDeleted?: boolean }>
  return list.filter((el) => !el.isDeleted).length
}
