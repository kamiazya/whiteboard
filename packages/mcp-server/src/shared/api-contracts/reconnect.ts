import { z } from 'zod'

// Single source of truth for both /api/reconnect-credential and
// /api/reconnect-session response shapes. server/routes/reconnect.ts and
// apps/web's reconnect-client.ts both import these, so the wire contract
// has exactly one definition instead of a server schema and a
// hand-maintained client mirror drifting apart (hence the export through
// the api-contracts barrel).
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
