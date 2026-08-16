import { type SpatialCanvas, spatialCanvasSchema } from '@kamiazya/whiteboard-model'
import { type CodecParseResult, codecFailure, codecSuccess } from '../errors.js'

export function parseSpatial(text: string): CodecParseResult<SpatialCanvas> {
  let rawValue: unknown
  try {
    rawValue = JSON.parse(text)
  } catch (error) {
    return codecFailure('json-syntax', `malformed JSON Canvas text: ${(error as Error).message}`)
  }

  const parsed = spatialCanvasSchema.safeParse(rawValue)
  if (!parsed.success) {
    return codecFailure(
      'json-canvas-schema',
      'JSON Canvas document failed schema validation',
      parsed.error,
    )
  }

  return codecSuccess(parsed.data)
}
