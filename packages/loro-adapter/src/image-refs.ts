/**
 * The one definition of "which uploaded files does this document state
 * reference", shared with every reader that decides a picture's fate. The
 * walk is model's `storedImageRefs` (file nodes, frame backgrounds, inline
 * images in text nodes and a markdown body); this adapts a stored document to
 * it. The browser's promote transfer and the daemon's file GC both decide a
 * blob's fate from it — two hand-rolled copies is how a new place a picture
 * can sit gets added to one side and a live image gets dropped by the other.
 */
import { imageRefId, storedImageRefs } from '@kamiazya/whiteboard-model'
import { type DocumentContainers, MARKDOWN_BODY_KEY } from './containers.js'
import { readSpatialCanvas } from './loro-bridge.js'

/** Ids of every uploaded file the doc state's current model references. */
export function collectImageRefIds(doc: DocumentContainers): Set<string> {
  // The body container only: a legacy body stored as a text node is already
  // part of the canvas read.
  const body = doc.getText(MARKDOWN_BODY_KEY).toString()
  return new Set(storedImageRefs({ canvas: readSpatialCanvas(doc), body }).map(imageRefId))
}
