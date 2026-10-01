import { z } from 'zod'

// Schema for the thin /api/w/:workspaceId/document/<path>/client-count endpoint
// that bridges an MCP tool to the daemon, so a wire-format change has exactly
// one place to update. The viewport route that lived beside it — awaiting an
// acknowledgement no client ever sent — is gone; the viewport tool reaches
// open pages through the in-process notifier instead.

// ── GET /api/w/:workspaceId/document/<path>/client-count ────────────────────
export const clientCountResponseSchema = z.object({
  count: z.number().int().nonnegative(),
  readyCount: z.number().int().nonnegative(),
})

export type ClientCountResponse = z.infer<typeof clientCountResponseSchema>
