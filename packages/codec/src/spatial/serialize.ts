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
  // `wire`, not `document`: a local by that name shadows the DOM global, and
  // arch-lint's boundary scan is textual — every mention reads as a DOM access
  // and fails this shared-layer package.
  const wire: JsonCanvasDocument = toJsonCanvas(canvas)
  if (mode === 'extended') return JSON.stringify(wire)
  const degraded = strictDegrade(wire)
  jsonCanvasDocumentSchema.parse(degraded)
  return JSON.stringify(degraded)
}
