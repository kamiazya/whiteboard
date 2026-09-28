import { z } from 'zod'

// daemon.json is the persisted contract for the local daemon's bearer token,
// process identity and the socket it answers on. This schema is the single
// source of truth for both the registry loader (daemon-registry.ts) and the
// CLI-facing parser (daemon-record.ts) — do not hand-write a parallel
// interface.
export const daemonRecordBaseSchema = z.object({
  pid: z.number().int().positive(),
  version: z.string(),
  startedAt: z.string(),
  // ADR-0050 decision 2: the owner-only socket (a named pipe on Windows) the
  // daemon answers on, and the only place it answers: it listens on no port.
  socketPath: z.string().min(1),
})

export const daemonRecordSchema = daemonRecordBaseSchema.extend({
  // A missing or empty token means the daemon cannot authenticate any
  // caller; treat that daemon.json as invalid rather than silently
  // producing a record with an unusable token (fail-closed).
  token: z.string().min(1),
})

export type DaemonRecordBase = z.infer<typeof daemonRecordBaseSchema>
export type DaemonRecord = z.infer<typeof daemonRecordSchema>
