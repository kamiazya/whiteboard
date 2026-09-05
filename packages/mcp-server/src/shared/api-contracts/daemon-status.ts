import { z } from 'zod'

// Wire contract for `whiteboard daemon status --json`. Transcribes the
// pre-existing DaemonStatusResult interface (cli/daemon-status.ts) field for
// field — this is a binding increment, not a rename, so no field name,
// optionality, or value set changes here.
export const daemonStatusResultSchema = z.object({
  schemaVersion: z.literal(1),
  ok: z.boolean(),
  // Not an enum: a future reason string must not become a runtime .parse()
  // crash for an otherwise-successful CLI invocation.
  reason: z.string().nullable(),
  recordFound: z.boolean(),
  recordFresh: z.boolean(),
  pidAlive: z.boolean().optional(),
  pingOk: z.boolean().optional(),
  statusOk: z.boolean().optional(),
  record: z
    .object({
      pid: z.number(),
      port: z.number(),
      version: z.string(),
      startedAt: z.string(),
    })
    .optional(),
})

export type DaemonStatusResult = z.infer<typeof daemonStatusResultSchema>
