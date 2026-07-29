import { z } from 'zod'

// Schemas for the thin /api/canvas/:workspaceId/:slug/* endpoints that drive
// browser-side state (viewport, client-count). These bridge MCP tools to the
// daemon, so a wire-format change has exactly one place to update.

// ── POST /api/canvas/:workspaceId/:slug/viewport ──────────────────────────
// The request body is forwarded to the browser unchanged (mode / elementIds /
// padding / animate / scrollX / scrollY / zoom) with no server-side schema —
// the canonical shape lives in shared/ws-messages.ts as
// viewportRequestMessageSchema.
const viewportResponseSchema = z.object({
  ok: z.literal(true),
})

// Shared error body. The route emits this for no_client (503), timeout (504),
// and internal (500). Optional fields cover legacy payloads.
const viewportErrorBodySchema = z.object({
  error: z.string().optional(),
  message: z.string().optional(),
  hint: z.string().optional(),
})

// ── GET /api/canvas/:workspaceId/:slug/client-count ───────────────────────
const clientCountResponseSchema = z.object({
  count: z.number().int().nonnegative(),
  readyCount: z.number().int().nonnegative(),
})

export type ViewportResponse = z.infer<typeof viewportResponseSchema>
export type ViewportErrorBody = z.infer<typeof viewportErrorBodySchema>
export type ClientCountResponse = z.infer<typeof clientCountResponseSchema>
