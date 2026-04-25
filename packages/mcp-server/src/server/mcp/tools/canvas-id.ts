import {
  ValidationError,
  validateSessionId,
  validateSlug,
} from '../../validators.js'

// canvasId uses the "{workspaceId}/{slug}" shape. Slugs may contain additional
// "/" characters, so only the first slash splits sessionId from slug.
// Example: "abc/621/header" -> { sessionId: "abc", slug: "621/header" }.
export function parseCanvasId(canvasId: string): { sessionId: string; slug: string } {
  const firstSlash = canvasId.indexOf('/')
  if (firstSlash === -1) {
    throw new ValidationError(
      'invalid_canvas_id',
      `Invalid canvasId "${canvasId}": expected "workspaceId/slug"`,
    )
  }
  const sessionId = canvasId.slice(0, firstSlash)
  const slug = canvasId.slice(firstSlash + 1)
  if (!sessionId || !slug) {
    throw new ValidationError(
      'invalid_canvas_id',
      `Invalid canvasId "${canvasId}": sessionId and slug must be non-empty`,
    )
  }
  return {
    sessionId: validateSessionId(sessionId),
    slug: validateSlug(slug),
  }
}
