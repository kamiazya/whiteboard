import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { strictDegrade } from './degrade.js'
import { type JsonCanvasDocument, jsonCanvasDocumentSchema } from './json-canvas.js'
import { toJsonCanvas } from './projection.js'

export type SpatialSerializeMode = 'strict' | 'extended'

/**
 * Write a document as JSON Canvas. Both modes go through
 * {@link toJsonCanvas} first, so the projection is the only place a document
 * becomes a JSON Canvas document and `JSON_CANVAS_PROJECTION` is the only
 * account of what that costs.
 *
 * `extended` is lossless over what the extension key can hold (round-trip
 * property in serialize.property.test.ts). `strict` applies
 * {@link strictDegrade} and re-validates against the wire schema — a degraded
 * document must still BE a JSON Canvas 1.0 document, not merely close enough
 * JSON.
 */
export function serializeSpatial(canvas: SpatialCanvas, mode: SpatialSerializeMode): string {
  const document: JsonCanvasDocument = toJsonCanvas(canvas)
  if (mode === 'extended') return JSON.stringify(document)
  const degraded = strictDegrade(document)
  jsonCanvasDocumentSchema.parse(degraded)
  return JSON.stringify(degraded)
}
