import { z } from 'zod'

// Single source of truth for both /api/reconnect-credential and
// /api/reconnect-session response shapes (server/routes/reconnect.ts). Kept
// under shared/api-contracts rather than inline in the route module so the
// wire contract has exactly one definition instead of a schema on the server
// side and a hand-maintained mirror on the client side drifting apart.
//
// Deliberately excluded from index.ts's published npm barrel (same
// carve-out as runtime.ts) — reconnect is a server-runtime concern, not a
// public API surface for external consumers of @kamiazya/whiteboard-mcp.
export const reconnectCredentialResponseSchema = z.object({
  reconnectSecret: z.string().min(1),
  expiresInDays: z.number().positive(),
})
export type ReconnectCredentialResponse = z.infer<typeof reconnectCredentialResponseSchema>

export const reconnectSessionResponseSchema = z.object({
  // Not `.min(1)`: tokenless local-daemon dev mode mounts this router with
  // `daemonToken: ''` (app.ts) and deliberately hands that empty token back
  // rather than refusing the whole reconnect surface — the same "auth is a
  // no-op when no token is configured" behavior every other /api/* route
  // already has.
  token: z.string(),
  reconnectSecret: z.string().min(1),
  expiresInDays: z.number().positive(),
})
export type ReconnectSessionResponse = z.infer<typeof reconnectSessionResponseSchema>
