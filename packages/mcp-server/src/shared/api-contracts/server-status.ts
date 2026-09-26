import { z } from 'zod'

// Wire contract for `whiteboard server status --json`. Transcribes the
// pre-existing ServerStatusResult union (cli/server-status.ts) arm for arm —
// a binding increment, not a rename, so no field name, optionality, or value
// set changes here.
//
// Discriminated on `ok` rather than on `state`, because `ok` is what splits
// the two SHAPES: the running arm carries the record's host/port/URL, and
// every other state carries nothing but the state itself. `state` has five
// values across those two shapes, so it discriminates the word, not the
// object.
//
// `state` is an enum rather than a string — the opposite of daemon-status's
// `reason`, and for the opposite reason. A reason is prose a future branch
// may add to, where a runtime .parse() crash on an otherwise-successful
// invocation would be the worse failure. `state` is switched on by the
// caller, exhaustively, and its type comes from this schema; a sixth state
// cannot be added without the compiler bringing you here first.
const serverStatusRunningSchema = z
  .object({
    schemaVersion: z.literal(1),
    ok: z.literal(true),
    state: z.literal('running'),
    pid: z.number(),
    host: z.string(),
    port: z.number(),
    publicBaseUrl: z.string(),
    authStrategy: z.literal('oauth-jwt'),
    startedAt: z.string(),
    recordFresh: z.literal(true),
  })
  .strict()

const serverStatusNotRunningSchema = z
  .object({
    schemaVersion: z.literal(1),
    ok: z.literal(false),
    state: z.enum(['missing', 'unreadable', 'stale', 'malformed', 'unverifiable']),
    recordFresh: z.literal(false),
  })
  .strict()

export const serverStatusResultSchema = z.discriminatedUnion('ok', [
  serverStatusRunningSchema,
  serverStatusNotRunningSchema,
])

export type ServerStatusResult = z.infer<typeof serverStatusResultSchema>
