import { canvasExistsResponseSchema } from '../../../shared/api-contracts/canvas.js'
import type { DaemonClient } from '../daemon-client.js'

// The daemon's snapshot GET / update POST routes (getDoc -> loadCanvas)
// silently create an empty workspace+canvas on first touch instead of
// erroring on an unknown id. That is the right default for canvas_create
// (an explicit "make this" request), but wrong for tools that only mean to
// mutate an *existing* canvas: a hallucinated or mistyped canvasId would
// otherwise write into a brand-new, empty canvas instead of failing loudly.
// Call this before any write so annotate / annotate_batch / load_image fail
// fast on an unregistered canvasId.
export async function assertCanvasExists(
  client: DaemonClient,
  workspaceId: string,
  slug: string,
): Promise<void> {
  const res = await client.request(`/api/canvas/${workspaceId}/${encodeURIComponent(slug)}/exists`)
  if (!res.ok) {
    throw new Error(`Failed to check canvas "${workspaceId}/${slug}" existence: ${res.status}`)
  }
  const parsed = canvasExistsResponseSchema.parse(await res.json())
  if (!parsed.exists) {
    throw new Error(
      `Canvas "${workspaceId}/${slug}" does not exist. Call canvas_create with slug "${slug}" first, or check canvasId for a typo.`,
    )
  }
}
