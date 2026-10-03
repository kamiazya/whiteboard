import { readSpatialCanvas } from '@kamiazya/whiteboard-loro-adapter'
import type { LoroDoc } from 'loro-crdt'

// The one "how many elements does this doc have" reader, for advisory counts
// (History panel / restore response / /api/debug).
//
// It lives in the shared layer rather than beside a store because it answers
// a question about the DOCUMENT, not about how a deployment keeps one — the
// question ADR-0018 uses to tell an operation from a mechanic. Filed under
// the daemon's `server/store/` it read as a mechanic to `adapter-mechanic-
// check.ts`, which classifies by directory, so two routes that legitimately
// ask a document its size were counted as ADR-0018 debt.
//
// - Edges are excluded: the bridge's edge-cascade invariant (an edge is
//   deleted whenever either endpoint node is removed) means an edge can
//   never outlive both of its nodes, so a nodes-only count is never 0 for
//   a non-empty scene.
// - The retired 'elements' movable list is not counted: nothing converts it
//   into nodes any more and no reader draws it, so a doc holding only that
//   list is an empty canvas to every other surface and counts as one here.
export function countAliveNodes(doc: LoroDoc): number {
  return readSpatialCanvas(doc).nodes.length
}
