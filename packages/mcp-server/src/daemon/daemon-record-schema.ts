import { z } from 'zod'

// daemon.json is the persisted contract for the local daemon's HTTP/WS
// Bearer token plus process identity. This schema is the single source of
// truth for both the registry loader (daemon-registry.ts) and the CLI-facing
// parser (daemon-record.ts) — do not hand-write a parallel interface.
// TCP ports are 1-65535 (0 is reserved for "any port", never a listening
// daemon's own bound port).
const MAX_TCP_PORT = 65535

export const daemonRecordBaseSchema = z.object({
  pid: z.number().int().positive(),
  port: z.number().int().positive().max(MAX_TCP_PORT),
  version: z.string(),
  startedAt: z.string(),
})

export const daemonRecordSchema = daemonRecordBaseSchema.extend({
  // A missing or empty token means the daemon cannot authenticate any
  // caller; treat that daemon.json as invalid rather than silently
  // producing a record with an unusable token (fail-closed).
  token: z.string().min(1),
})

export type DaemonRecordBase = z.infer<typeof daemonRecordBaseSchema>
export type DaemonRecord = z.infer<typeof daemonRecordSchema>
