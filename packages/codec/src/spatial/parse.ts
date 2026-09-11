import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { type CodecParseResult, codecFailure, codecSuccess } from '../errors.js'
import { fromJsonCanvas, jsonCanvasDocumentSchema } from './projection.js'

/**
 * Read JSON Canvas text as a document. The text is validated against the WIRE
 * schema and then lifted by {@link fromJsonCanvas}: what arrives is a JSON
 * Canvas document, and what leaves is this product's model, with the one
 * conversion between them in the projection module.
 */
export function parseSpatial(text: string): CodecParseResult<SpatialCanvas> {
  let rawValue: unknown
  try {
    rawValue = JSON.parse(text)
  } catch (error) {
    return codecFailure('json-syntax', `malformed JSON Canvas text: ${(error as Error).message}`)
  }

  const parsed = jsonCanvasDocumentSchema.safeParse(rawValue)
  if (!parsed.success) {
    return codecFailure(
      'json-canvas-schema',
      'JSON Canvas document failed schema validation',
      parsed.error,
    )
  }

  return codecSuccess(fromJsonCanvas(parsed.data))
}
