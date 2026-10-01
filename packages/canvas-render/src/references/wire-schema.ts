import { fromJsonCanvas, jsonCanvasDocumentSchema, toJsonCanvas } from '@kamiazya/whiteboard-codec'
import { documentIdSchema } from '@kamiazya/whiteboard-model'
import { z } from 'zod'
import type { LoadedReference } from './loaded-reference.js'

/**
 * One `LoadedReference` as it crosses a process boundary — the shape
 * `canvas_view` declares in its output schema and the MCP Apps widget
 * validates on arrival, declared ONCE here because both sides may import
 * this package and neither may import the other.
 *
 * A canvas crosses as JSON Canvas, the one projection a reader of this wire
 * knows, which is why the schema is not `LoadedReference` with a Zod wrapper:
 * the two sides each held their own copy for a while, and the widget's
 * validated the field against the strict model schema while the server sent
 * the projection — `type` and `text` are unknown keys to the model — so
 * every referenced board was dropped as unparseable while a referenced note
 * still drew, and nothing was red because each copy's tests agreed with
 * itself.
 *
 * Every field is optional and OMITTED rather than sent undefined, because
 * the reader distinguishes "no body" from "an empty one".
 */
export const loadedReferenceWireSchema = z
  .object({
    /** The canonical id, so the seams answer by id when the node wrote a path. */
    documentId: documentIdSchema.optional(),
    /** The document's display name, so the node's label is not a raw id. */
    name: z.string().optional(),
    /** Present only for a markdown document: its raw body, parsed by the seams. */
    body: z.string().optional(),
    /** Present only for a spatial document: its canvas, as JSON Canvas. */
    canvas: jsonCanvasDocumentSchema.optional(),
  })
  .strict()

export type LoadedReferenceWire = z.infer<typeof loadedReferenceWireSchema>

export function loadedReferenceToWire(loaded: LoadedReference): LoadedReferenceWire {
  return {
    ...(loaded.documentId !== undefined ? { documentId: loaded.documentId } : {}),
    ...(loaded.name !== undefined ? { name: loaded.name } : {}),
    ...(loaded.body !== undefined ? { body: loaded.body } : {}),
    ...(loaded.canvas !== undefined ? { canvas: toJsonCanvas(loaded.canvas) } : {}),
  }
}

export function loadedReferenceFromWire(wire: LoadedReferenceWire): LoadedReference {
  return {
    ...(wire.documentId !== undefined ? { documentId: wire.documentId } : {}),
    ...(wire.name !== undefined ? { name: wire.name } : {}),
    ...(wire.body !== undefined ? { body: wire.body } : {}),
    ...(wire.canvas !== undefined ? { canvas: fromJsonCanvas(wire.canvas) } : {}),
  }
}
