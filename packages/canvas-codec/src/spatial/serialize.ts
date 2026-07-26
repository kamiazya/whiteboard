import type { SpatialCanvas } from '@kamiazya/whiteboard-canvas-model'
import { spatialCanvasSchema } from '@kamiazya/whiteboard-canvas-model'
import { strictDegrade } from './degrade.js'

export type SpatialSerializeMode = 'strict' | 'extended'

/**
 * `extended` mode is a lossless serialization of the model as-is (round-trip
 * property in serialize.property.test.ts). `strict` mode applies
 * {@link strictDegrade} first and re-validates the result against
 * `spatialCanvasSchema` — a degraded document must still be a valid JSON
 * Canvas 1.0 document, not merely "close enough" JSON.
 */
export function serializeSpatial(canvas: SpatialCanvas, mode: SpatialSerializeMode): string {
  const output = mode === 'strict' ? strictDegrade(canvas) : canvas
  if (mode === 'strict') {
    spatialCanvasSchema.parse(output)
  }
  return JSON.stringify(output)
}
