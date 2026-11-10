import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { type CodecParseResult, codecFailure, codecSuccess } from '../errors.js'
import { jsonCanvasDocumentSchema } from './json-canvas.js'
import { fromJsonCanvas } from './projection.js'

/**
 * The TypeScript READER of JSON Canvas text, for the one realm with no Rust
 * core: the MCP Apps widget iframe and the viewer that shares its code
 * (`canvas-viewer`'s `parseViewerScene`). The daemon and the web app answer
 * JSON Canvas through the core alone (`parseSpatial`, `serializeSpatial`), which
 * has no fallback to this; arch-lint keeps them from importing it. There is no
 * TypeScript writer: a viewer only reads.
 *
 * The text is validated against the WIRE schema and then lifted by
 * {@link fromJsonCanvas}: what arrives is a JSON Canvas document, and what
 * leaves is this product's model, with the one conversion between them in the
 * projection module. It declines nothing, so a document the core refuses (past
 * 4 MiB, a lone surrogate, nesting past 64) the viewer still draws.
 */
export function readJsonCanvasText(text: string): CodecParseResult<SpatialCanvas> {
  let rawValue: unknown
  try {
    rawValue = JSON.parse(text)
  } catch (error) {
    return codecFailure('json-syntax', `malformed JSON Canvas text: ${(error as Error).message}`)
  }

  if (carriesConversation(rawValue)) {
    return codecFailure(
      'json-canvas-schema',
      'this file carries x-whiteboard.comments, a conversation an exported file no longer holds: comments live on the document, not in the file. Remove the key to import the content',
    )
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

/**
 * Whether a file still holds the annotation layer an older export wrote into
 * the canvas-level extension. A file carries content and not the conversation
 * (ADR-0026 decision 1b), so nothing reads that key — and a reader that let the
 * wire schema strip it would import the board and lose every comment with no
 * word said. Refused instead, by name, so the person importing it decides.
 */
function carriesConversation(raw: unknown): boolean {
  if (raw === null || typeof raw !== 'object' || !('x-whiteboard' in raw)) return false
  const extension = raw['x-whiteboard']
  if (extension === null || typeof extension !== 'object' || !('comments' in extension))
    return false
  // An empty list holds nothing to lose; the wire schema drops the key as it
  // drops any other it does not name.
  const comments = extension.comments
  return Array.isArray(comments) && comments.length > 0
}
