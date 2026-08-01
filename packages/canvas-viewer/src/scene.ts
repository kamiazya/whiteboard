import type { CodecParseError, CodecParseResult } from '@kamiazya/whiteboard-canvas-codec'
import {
  parseSpatial,
  type SpatialSerializeMode,
  serializeSpatial,
} from '@kamiazya/whiteboard-canvas-codec'
import type { SpatialCanvas } from '@kamiazya/whiteboard-canvas-model'
import { spatialCanvasSchema } from '@kamiazya/whiteboard-canvas-model'

// The viewer's scene model IS canvas-model's spatial canvas — re-exported,
// never redeclared. A second spatial schema here would be exactly the
// drift class this repo's zod-schema-discipline forbids.
export const viewerSceneSchema = spatialCanvasSchema
export type ViewerScene = SpatialCanvas

/**
 * Total parser: never throws a raw ZodError/SyntaxError, mirroring
 * canvas-codec's own CodecParseResult contract. A string input goes through
 * parseSpatial (JSON-syntax stage included); an already-parsed value (e.g.
 * an embedded <script> JSON.parse() result, or an MCP structuredContent
 * payload) is validated directly against the schema.
 */
export function parseViewerScene(input: unknown): CodecParseResult<ViewerScene> {
  if (typeof input === 'string') return parseSpatial(input)

  const parsed = spatialCanvasSchema.safeParse(input)
  if (!parsed.success) {
    const error: CodecParseError = {
      stage: 'json-canvas-schema',
      message: 'JSON Canvas document failed schema validation',
      issues: parsed.error.issues,
    }
    return { ok: false, error }
  }
  return { ok: true, value: parsed.data }
}

/** Thin delegation to canvas-codec's serializer — no separate viewer-side logic. */
export function serializeViewerScene(canvas: ViewerScene, mode: SpatialSerializeMode): string {
  return serializeSpatial(canvas, mode)
}
