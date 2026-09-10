import { z } from 'zod'

// Schemas for the thin /api/w/:workspaceId/document/<path>/* endpoints that drive
// browser-side state (viewport, client-count). These bridge MCP tools to the
// daemon, so a wire-format change has exactly one place to update.

// ── POST /api/w/:workspaceId/document/<path>/viewport ───────────────────────
// The request body is what the browser reads off the `viewport_request`
// frame (mode / elementIds / animate / scrollX / scrollY / zoom), checked
// against `viewportRequestParamsSchema` in daemon-client's ws-messages.ts —
// derived from the frame's own schema, so the route and the browser cannot
// disagree about what a viewport may be asked.
export const viewportResponseSchema = z.object({
  ok: z.literal(true),
})

// Shared error body. The route emits this for no_client (503), timeout (504),
// and internal (500). Every branch sets error and message; only no_client
// carries a hint, so that is the one genuinely optional field.
export const viewportErrorBodySchema = z.object({
  error: z.string(),
  message: z.string(),
  hint: z.string().optional(),
})

// ── GET /api/w/:workspaceId/document/<path>/client-count ────────────────────
export const clientCountResponseSchema = z.object({
  count: z.number().int().nonnegative(),
  readyCount: z.number().int().nonnegative(),
})

export type ViewportResponse = z.infer<typeof viewportResponseSchema>
export type ViewportErrorBody = z.infer<typeof viewportErrorBodySchema>
export type ClientCountResponse = z.infer<typeof clientCountResponseSchema>
