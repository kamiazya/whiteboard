import { z } from 'zod'

// Wire contract for the `whiteboard daemon run --json` ready payload. The
// daemon listens on its owner-only socket and no TCP port (ADR-0050), so the
// socket is where a caller reaches it.
export const daemonRunReadyResultSchema = z.object({
  schemaVersion: z.literal(1),
  ok: z.literal(true),
  pid: z.number(),
  socketPath: z.string(),
  version: z.string(),
  startedAt: z.string(),
})

export type DaemonRunReadyResult = z.infer<typeof daemonRunReadyResultSchema>
