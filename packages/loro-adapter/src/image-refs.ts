/**
 * The one definition of "which uploaded files does this document state
 * reference". The browser's promote transfer and the daemon's file GC both
 * decide a blob's fate from this walk — two hand-rolled copies of it is how
 * a future node type gets added to one side and a live image gets dropped
 * or purged by the other.
 */
import { imageRefId, isImageRef } from '@kamiazya/whiteboard-model'
import type { DocumentContainers } from './loro-bridge.js'
import { readSpatialCanvas } from './loro-bridge.js'

/** Ids of every uploaded file the doc state's current model references. */
export function collectImageRefIds(doc: DocumentContainers): Set<string> {
  const ids = new Set<string>()
  for (const node of readSpatialCanvas(doc).nodes) {
    if (node.type === 'file' && isImageRef(node.file)) ids.add(imageRefId(node.file))
  }
  return ids
}
