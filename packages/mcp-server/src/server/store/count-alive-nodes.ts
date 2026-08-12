import { readSpatialCanvas } from '@kamiazya/whiteboard-canvas-workspace'
import type { LoroDoc } from 'loro-crdt'

// Shared "how many elements does this doc have" reader for the daemon's
// advisory UI counts (History panel / restore response / /api/debug) — see
// file-gc.ts's collectFromDoc for the sibling reader in this module family.
//
// Two decisions, both pinned by count-alive-nodes.test.ts:
//
// - Edges are excluded. The bridge's edge-cascade invariant
//   (writeSpatialCanvas/deleteSpatialNode delete an edge whenever either
//   endpoint node is removed) means an edge can never outlive both of its
//   nodes, so a nodes-only count is never 0 for a non-empty scene — it does
//   not need edges to avoid under-reporting, and the UI label ("N els")
//   historically counted the legacy 'elements' list, which had no
//   edge/node distinction to begin with.
// - The legacy 'elements' movable-list walk is a FALLBACK, not an additive
//   pass like file-gc's collectFromDoc. file-gc unions fileIds into a Set,
//   where visiting the same file from both passes is a harmless no-op; a
//   count that summed both passes would double-count a doc mid-migration
//   that happens to have both shapes populated (nodes map written by a
//   resave, stale legacy entries never cleared). Falling back only when the
//   nodes map is empty means a pre-migration doc (nodes empty, legacy
//   populated) still reports its real count, and a migrated doc (nodes
//   populated) never consults potentially-stale legacy entries.
export function countAliveNodes(doc: LoroDoc): number {
  const { nodes } = readSpatialCanvas(doc)
  if (nodes.length > 0) return nodes.length

  const list = doc.getMovableList('elements').toJSON() as Array<{ isDeleted?: boolean }>
  return list.filter((el) => !el.isDeleted).length
}
