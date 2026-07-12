import { z } from 'zod'

// instanceId (a per-daemon-start crypto.randomUUID) replaces the OS pid here.
// pid is reused by the OS across processes, so a stale record comparing pid
// alone can misidentify an unrelated process as "our" daemon; instanceId is
// unique per start and never reused, closing that identity-confusion window
// for the CLI's stop/status/doctor checks that read this endpoint.
export const daemonPingResponseSchema = z.object({
  ok: z.literal(true),
  instanceId: z.string(),
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
  // 'web-app' is the canonical apps/web build (dist/web-app), served by the
  // local daemon. 'server-placeholder' is the minimal static page served at
  // server-mode's root (apps/web is not served there — server-mode has no
  // token/session-acquisition flow apps/web's provider model can use).
  app: z.object({
    served: z.boolean(),
    buildPresent: z.boolean(),
    ui: z.enum(['web-app', 'server-placeholder']),
  }),
  mcp: z.object({ httpEnabled: z.boolean(), endpoint: z.string() }),
  clients: z.object({ connected: z.number(), ready: z.number() }),
  publicBaseUrl: z.string().optional(),
})

export type RuntimeStatusResponse = z.infer<typeof runtimeStatusResponseSchema>
