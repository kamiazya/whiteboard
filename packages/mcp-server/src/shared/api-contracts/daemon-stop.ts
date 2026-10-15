import { z } from 'zod'

// Wire contract for `whiteboard daemon stop --json`. Transcribes the
// pre-existing DaemonStopResult interface (cli/daemon-stop.ts) field for
// field — binding increment, not a rename.
export const daemonStopResultSchema = z
  .object({
    schemaVersion: z.literal(1),
    ok: z.boolean(),
    action: z.enum(['stopped', 'not-running', 'refused']),
    reason: z.string().nullable(),
    pid: z.number().nullable(),
    // On an `identity-unconfirmed` refusal, the pid the daemon answering on
    // the record's socket named, when its answer named one: the process to
    // stop, which the record cannot identify.
    servingPid: z.number().int().positive().optional(),
  })
  .strict()

export type DaemonStopResult = z.infer<typeof daemonStopResultSchema>
