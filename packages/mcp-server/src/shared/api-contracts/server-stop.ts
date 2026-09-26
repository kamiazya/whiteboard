import { z } from 'zod'

// Wire contract for `whiteboard server stop --json`. Transcribes the
// pre-existing ServerStopResult interface (cli/server-stop.ts) field for
// field — a binding increment, not a rename.
//
// `.strict()` is the point rather than a default. The result is assembled by
// one funnel that SPREADS its caller's object in, and TypeScript's
// excess-property check does not apply to a spread — so a widened result
// compiles clean and publishes whatever it was handed. Measured on
// `server status`: spreading the server-mode record in typechecks at exit 0
// and leaks `instanceId` into a documented CLI contract.
//
// `action` and `reason` are enums because both are switched on and both come
// from this file's own closed set; a tenth reason cannot be written without
// the compiler stopping here first, since the caller's type is z.infer of
// this schema.
export const serverStopResultSchema = z
  .object({
    schemaVersion: z.literal(1),
    ok: z.boolean(),
    action: z.enum(['stopped', 'not-running', 'refused']),
    reason: z
      .enum([
        'server-record-not-found',
        'server-record-malformed',
        'server-record-unreadable',
        'server-process-not-running',
        'server-stop-signal-failed',
        'server-stop-timeout',
        // Record predates instanceId (written by an older daemon build).
        // Identity cannot be confirmed, so the safe choice is to refuse to
        // kill rather than risk terminating an unrelated process that
        // reused the recorded pid.
        'server-instance-unverifiable',
      ])
      .nullable(),
    recordFound: z.boolean(),
    recordFresh: z.boolean(),
    pid: z.number().optional(),
  })
  .strict()

export type ServerStopResult = z.infer<typeof serverStopResultSchema>
