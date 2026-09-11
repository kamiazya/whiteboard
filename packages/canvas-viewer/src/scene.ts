import type { CodecParseError, CodecParseResult } from '@kamiazya/whiteboard-codec'
import {
  fromJsonCanvas,
  jsonCanvasDocumentSchema,
  parseSpatial,
  type SpatialSerializeMode,
  serializeSpatial,
} from '@kamiazya/whiteboard-codec'
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'

/**
 * What this widget ACCEPTS is a JSON Canvas document — a file another tool may
 * have written — so the published input contract is codec's wire schema,
 * re-exported and never redeclared. It deliberately does not follow the
 * product's own model: ADR-0035 moves that away from the format, and an input
 * contract that tracked it would break every third-party document the moment
 * it did.
 */
export const viewerSceneSchema = jsonCanvasDocumentSchema

/**
 * What the viewer HOLDS once a scene is parsed: the model, because that is
 * what the renderer draws. Accepting the format and holding the model is the
 * whole shape of the seam — `parseViewerScene` is where the lift happens, and
 * it happens on both input paths or the two disagree.
 */
export type ViewerScene = SpatialCanvas

/**
 * Total parser: never throws a raw ZodError/SyntaxError, mirroring
 * codec's own CodecParseResult contract. A string input goes through
 * parseSpatial (JSON-syntax stage included); an already-parsed value (e.g.
 * an embedded <script> JSON.parse() result, or an MCP structuredContent
 * payload) is validated directly against the schema.
 */
export function parseViewerScene(input: unknown): CodecParseResult<ViewerScene> {
  if (typeof input === 'string') return parseSpatial(input)

  const parsed = jsonCanvasDocumentSchema.safeParse(input)
  if (!parsed.success) {
    const error: CodecParseError = {
      stage: 'json-canvas-schema',
      message: 'JSON Canvas document failed schema validation',
      issues: parsed.error.issues,
    }
    return { ok: false, error }
  }
  return { ok: true, value: fromJsonCanvas(parsed.data) }
}

/** Thin delegation to codec's serializer — no separate viewer-side logic. */
export function serializeViewerScene(canvas: ViewerScene, mode: SpatialSerializeMode): string {
  return serializeSpatial(canvas, mode)
}
