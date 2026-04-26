import {
  ValidationError,
  validateWorkspaceId,
  validateSlug,
} from '../../validators.js'

// canvasId uses the "{workspaceId}/{slug}" shape. Slugs may contain additional
// "/" characters, so only the first slash splits workspaceId from slug.
// Example: "abc/621/header" -> { workspaceId: "abc", slug: "621/header" }.
export function parseCanvasId(canvasId: string): { workspaceId: string; slug: string } {
  const firstSlash = canvasId.indexOf('/')
  if (firstSlash === -1) {
    throw new ValidationError(
      'invalid_canvas_id',
      `Invalid canvasId "${canvasId}": expected "workspaceId/slug"`,
    )
  }
  const workspaceId = canvasId.slice(0, firstSlash)
  const slug = canvasId.slice(firstSlash + 1)
  if (!workspaceId || !slug) {
    throw new ValidationError(
      'invalid_canvas_id',
      `Invalid canvasId "${canvasId}": workspaceId and slug must be non-empty`,
    )
  }
  return {
    workspaceId: validateWorkspaceId(workspaceId),
    slug: validateSlug(slug),
  }
}
