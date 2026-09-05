import { z } from 'zod'

// Wire contract for the `whiteboard daemon run --json` ready payload.
// Transcribes the pre-existing DaemonRunReadyResult interface
// (cli/daemon-run.ts) field for field — binding increment, not a rename.
export const daemonRunReadyResultSchema = z.object({
  schemaVersion: z.literal(1),
  ok: z.literal(true),
  pid: z.number(),
  port: z.number(),
  host: z.string(),
  version: z.string(),
  startedAt: z.string(),
})

export type DaemonRunReadyResult = z.infer<typeof daemonRunReadyResultSchema>
