import { readSpatialCanvas } from '@kamiazya/whiteboard-loro-adapter'
import type { LoroDoc } from 'loro-crdt'
import { z } from 'zod'

// The legacy movable-list entry crossed a persistence boundary (loaded from
// a .loro snapshot on disk), so its shape is asserted at runtime rather than
// cast — a corrupt or foreign-shaped entry is dropped instead of silently
// flowing through as `{ isDeleted: undefined }`.
const legacyElementSchema = z.object({ isDeleted: z.boolean().optional() }).passthrough()

function readLegacyElements(doc: LoroDoc): Array<z.infer<typeof legacyElementSchema>> {
  // LoroMovableList#toJSON() is typed `any` upstream; narrow to `unknown[]`
  // (never a shaped type) so per-item validation below is what does the
  // real work, not the compiler.
  const list = doc.getMovableList('elements').toJSON() as unknown[]
  return list.flatMap((item) => {
    const parsed = legacyElementSchema.safeParse(item)
    return parsed.success ? [parsed.data] : []
  })
}

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

  return readLegacyElements(doc).filter((el) => !el.isDeleted).length
}

// Tombstone count is legacy-list-only by definition (a nodes-model doc has
// none: deleteSpatialNode removes the entry outright rather than marking it
// dead), so it follows the same nodes-present guard as countAliveNodes above
// — otherwise a migrated doc's stale, disconnected legacy list would leak
// into a debug count that is supposed to describe the current doc.
export function countLegacyTombstones(doc: LoroDoc): number {
  const { nodes } = readSpatialCanvas(doc)
  if (nodes.length > 0) return 0

  return readLegacyElements(doc).filter((el) => el.isDeleted === true).length
}
