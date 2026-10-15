import { z } from 'zod'

// Wire contract for `whiteboard daemon status --json`. Transcribes the
// pre-existing DaemonStatusResult interface (cli/daemon-status.ts) field for
// field — this is a binding increment, not a rename, so no field name,
// optionality, or value set changes here.
export const daemonStatusResultSchema = z
  .object({
    schemaVersion: z.literal(1),
    ok: z.boolean(),
    // Not an enum: a future reason string must not become a runtime .parse()
    // crash for an otherwise-successful CLI invocation.
    reason: z.string().nullable(),
    recordFound: z.boolean(),
    recordFresh: z.boolean(),
    pidAlive: z
      .boolean()
      .describe(
        "Whether something may still hold the record: the daemon it names is running, or something serves the record's socket. False when that process has exited, and when its pid now belongs to a later process that nothing on the socket vouches for.",
      )
      .optional(),
    // The pid a runtime status on the record's socket named when it was not
    // the record's pid — the process a person has to stop before a daemon of
    // this build can start there. Absent where nothing answered, the answer
    // named no pid, or the socket was not asked.
    servingPid: z.number().int().positive().optional(),
    pingOk: z.boolean().optional(),
    statusOk: z.boolean().optional(),
    record: z
      .object({
        pid: z.number(),
        version: z.string(),
        startedAt: z.string(),
      })
      .strict()
      .optional(),
  })
  .strict()

export type DaemonStatusResult = z.infer<typeof daemonStatusResultSchema>
