import { z } from 'zod'

// OQ5 (security decision, not resolved here): pid is process-internal data that
// becomes cross-origin-readable once CORS is applied to /api/runtime/ping.
// The schema keeps pid present; stripping it requires a separate human decision.
export const daemonPingResponseSchema = z.object({
  ok: z.literal(true),
  pid: z.number(),
})

export type DaemonPingResponse = z.infer<typeof daemonPingResponseSchema>

export const runtimeStatusResponseSchema = z.object({
  ok: z.boolean(),
  pid: z.number(),
  host: z.string(),
  port: z.number(),
  baseUrl: z.string(),
  version: z.string(),
  startedAt: z.string(),
  uptimeMs: z.number(),
  idleForMs: z.number(),
  auth: z.object({ mode: z.string(), hasToken: z.boolean() }),
  storage: z.object({ dataDir: z.string(), dataDirWritable: z.boolean() }),
  app: z.object({ served: z.boolean(), buildPresent: z.boolean() }),
  mcp: z.object({ httpEnabled: z.boolean(), endpoint: z.string() }),
  clients: z.object({ connected: z.number(), ready: z.number() }),
  publicBaseUrl: z.string().optional(),
})

export type RuntimeStatusResponse = z.infer<typeof runtimeStatusResponseSchema>
