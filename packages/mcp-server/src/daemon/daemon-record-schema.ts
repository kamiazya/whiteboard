import { z } from 'zod'

// daemon.json is the persisted contract for the local daemon's bearer token,
// process identity and the socket it answers on. This schema is the single
// source of truth for its one reader (daemon-record.ts) — do not hand-write a
// parallel interface.
// What the daemon process is running: its TypeScript source (the watch-mode
// dev daemon) or a build under dist/ (`pnpm mcp:http`, `whiteboard daemon run`,
// the packaged install). A watch-mode start that finds a built daemon on its
// data dir has to say so, because a source edit will never reach that process.
// The dev scripts spell `'built'` once, as `BUILT_LAUNCH`, held to this enum by
// dev-daemon-socket-lib.test.ts.
const daemonLaunchSchema = z.enum(['built', 'source'])
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
  // Optional for a READER: a daemon still running from before the field
  // existed still names itself. Every writer supplies it (`DaemonRecordWrite`).
  launch: daemonLaunchSchema.optional(),
})

export const daemonRecordSchema = daemonRecordBaseSchema.extend({
  // A missing or empty token means the daemon cannot authenticate any
  // caller; treat that daemon.json as invalid rather than silently
  // producing a record with an unusable token (fail-closed).
  token: z.string().min(1),
})

/**
 * What a record this build cannot interpret still says about its daemon: the
 * pid it must, and whatever else reads as itself. Enough to ask whether that
 * daemon is still there, and to name it to a person.
 */
export const recordedDaemonSchema = daemonRecordBaseSchema.pick({ pid: true }).extend({
  version: z.string().optional().catch(undefined),
  startedAt: z.string().optional().catch(undefined),
  socketPath: z.string().min(1).optional().catch(undefined),
  token: z.string().min(1).optional().catch(undefined),
})

export type RecordedDaemon = z.infer<typeof recordedDaemonSchema>
export type DaemonRecordBase = z.infer<typeof daemonRecordBaseSchema>
export type DaemonRecord = z.infer<typeof daemonRecordSchema>

/**
 * What a daemon writes: a record with its launch, which only a reader may find
 * absent. A writer that left it out would be read as watch-mode source.
 */
export type DaemonRecordWrite = DaemonRecord & { launch: DaemonLaunch }
