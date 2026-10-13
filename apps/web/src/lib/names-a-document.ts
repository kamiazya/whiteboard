import { referenceTargets } from '@kamiazya/whiteboard-canvas-render'
import { isImageRef, type SpatialCanvas } from '@kamiazya/whiteboard-model'

/**
 * Whether content names another DOCUMENT — what a picture of it drawn
 * without references is missing. A stored picture is not one: it is drawn
 * from the file store, never from the reference wire.
 *
 * Asked by whichever realm holds the content: the worker for a board it
 * decoded, the row loader for a note body it read.
 */
export function namesADocument(seeds: {
  readonly bodies?: readonly string[]
  readonly canvases?: readonly SpatialCanvas[]
}): boolean {
  return referenceTargets(seeds).some((target) => !isImageRef(target))
}
