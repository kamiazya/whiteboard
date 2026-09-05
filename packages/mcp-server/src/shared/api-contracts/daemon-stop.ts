import { z } from 'zod'

// Wire contract for `whiteboard daemon stop --json`. Transcribes the
// pre-existing DaemonStopResult interface (cli/daemon-stop.ts) field for
// field — binding increment, not a rename.
export const daemonStopResultSchema = z.object({
  schemaVersion: z.literal(1),
  ok: z.boolean(),
  action: z.enum(['stopped', 'not-running', 'refused']),
  reason: z.string().nullable(),
  pid: z.number().nullable(),
})

export type DaemonStopResult = z.infer<typeof daemonStopResultSchema>
