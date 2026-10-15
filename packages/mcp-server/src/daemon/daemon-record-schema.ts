import { z } from 'zod'

// daemon.json is the persisted contract for the local daemon's bearer token,
// process identity and the socket it answers on. This schema is the single
// source of truth for both the registry loader (daemon-registry.ts) and the
// CLI-facing parser (daemon-record.ts) — do not hand-write a parallel
// interface.
// What the daemon process is running: its TypeScript source (the watch-mode
// dev daemon) or a build under dist/ (`pnpm mcp:http`, the packaged install).
// A watch-mode start that finds a built daemon on its data dir has to say so,
// because a source edit will never reach that process.
export const daemonLaunchSchema = z.enum(['built', 'source'])
export type DaemonLaunch = z.infer<typeof daemonLaunchSchema>

/** The launch of the process whose module is `moduleUrl`: only source runs as `.ts`. */
export function daemonLaunchOfModule(moduleUrl: string): DaemonLaunch {
  return moduleUrl.endsWith('.ts') ? 'source' : 'built'
}

export const daemonRecordBaseSchema = z.object({
  pid: z.number().int().positive(),
  version: z.string(),
  startedAt: z.string(),
  // ADR-0050 decision 2: the owner-only socket (a named pipe on Windows) the
  // daemon answers on, and the only place it answers: it listens on no port.
  socketPath: z.string().min(1),
  // Optional: a record written before the field existed still names a daemon.
  launch: daemonLaunchSchema.optional(),
})

export const daemonRecordSchema = daemonRecordBaseSchema.extend({
  // A missing or empty token means the daemon cannot authenticate any
  // caller; treat that daemon.json as invalid rather than silently
  // producing a record with an unusable token (fail-closed).
  token: z.string().min(1),
})

export type DaemonRecordBase = z.infer<typeof daemonRecordBaseSchema>
export type DaemonRecord = z.infer<typeof daemonRecordSchema>
