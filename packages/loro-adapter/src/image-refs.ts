/**
 * The one definition of "which uploaded files does this document state
 * reference". The browser's promote transfer and the daemon's file GC both
 * decide a blob's fate from this walk — two hand-rolled copies of it is how
 * a future node type gets added to one side and a live image gets dropped
 * or purged by the other.
 */
import { imageRefId, isImageRef, nodeFile } from '@kamiazya/whiteboard-model'
import type { DocumentContainers } from './containers.js'
import { readSpatialCanvas } from './loro-bridge.js'

/** Ids of every uploaded file the doc state's current model references. */
export function collectImageRefIds(doc: DocumentContainers): Set<string> {
  const ids = new Set<string>()
  for (const node of readSpatialCanvas(doc).nodes) {
    const file = nodeFile(node)
    if (file !== undefined && isImageRef(file)) ids.add(imageRefId(file))
  }
  return ids
}
