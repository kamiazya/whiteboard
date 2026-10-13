import { imageTargets, referenceTargets } from '@kamiazya/whiteboard-canvas-render'
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'

/**
 * Whether content names anything a picture of it drawn without references
 * is missing: another DOCUMENT (`referenceTargets`), or a stored picture
 * (`imageTargets`) — an image's bytes live in the keeper's file store, and
 * a render that was handed none draws the image as its card.
 *
 * Asked by whichever realm holds the content: the worker for a board it
 * decoded, the row loader for a note body it read.
 */
export function namesAReference(seeds: {
  readonly bodies?: readonly string[]
  readonly canvases?: readonly SpatialCanvas[]
}): boolean {
  return referenceTargets(seeds).length > 0 || imageTargets(seeds).length > 0
}
