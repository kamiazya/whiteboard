import type { DocumentContainers } from './containers.js'
import { readSpatialCanvas } from './loro-bridge.js'

/**
 * How many nodes a document's canvas holds, for advisory counts (the History
 * panel, a restore response, `/api/debug`). The one reader of that question:
 * it answers about the DOCUMENT rather than about how a deployment keeps one,
 * so it sits in the shared layer both keepers import.
 *
 * - Edges are excluded: the bridge's edge-cascade invariant (an edge is
 *   deleted whenever either endpoint node is removed) means an edge can never
 *   outlive both of its nodes, so a nodes-only count is never 0 for a
 *   non-empty scene.
 * - The retired 'elements' movable list is not counted: nothing converts it
 *   into nodes any more and no reader draws it.
 * - Soft-failing: a count is advisory, so a document whose canvas cannot be
 *   read (a markdown document has none) counts 0 rather than failing the save
 *   or response that asked.
 */
export function countSpatialNodes(doc: DocumentContainers): number {
  try {
    return readSpatialCanvas(doc).nodes.length
  } catch {
    return 0
  }
}
