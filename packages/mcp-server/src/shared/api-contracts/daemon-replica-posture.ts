import { replicaTierSchema } from '@kamiazya/whiteboard-daemon-client/api-contracts/replica-key'
import { z } from 'zod'

// Wire contracts for `whiteboard daemon rotate-replica-key --json` and
// `whiteboard daemon set-replica-tier --json`: what the CLI prints after
// asking the running daemon, which is the only process that holds the key
// store. `ok: false` says why the daemon could not be asked, or what it
// answered when it refused; a parse failure on the daemon's own 2xx is
// reported rather than passed through, so a keyId the CLI prints is one the
// contract vouched for.

const refusedSchema = z
  .object({
    schemaVersion: z.literal(1),
    ok: z.literal(false),
    workspaceId: z.string(),
    reason: z.enum(['daemon-not-running', 'refused', 'malformed-response', 'unreachable']),
    /** The daemon's HTTP status, when it answered at all. */
    status: z.number().int().optional(),
    message: z.string(),
  })
  .strict()

export const daemonRotateReplicaKeyResultSchema = z.union([
  z
    .object({
      schemaVersion: z.literal(1),
      ok: z.literal(true),
      workspaceId: z.string(),
      /** The id of the pair the workspace is keyed under now — never the key. */
      keyId: z.string(),
    })
    .strict(),
  refusedSchema,
])
export type DaemonRotateReplicaKeyResult = z.infer<typeof daemonRotateReplicaKeyResultSchema>

export const daemonSetReplicaTierResultSchema = z.union([
  z
    .object({
      schemaVersion: z.literal(1),
      ok: z.literal(true),
      workspaceId: z.string(),
      /** The override as stored; `null` once cleared. */
      tier: replicaTierSchema.nullable(),
      /** What the workspace resolves to, the process default included. */
      effectiveTier: replicaTierSchema,
    })
    .strict(),
  refusedSchema,
])
export type DaemonSetReplicaTierResult = z.infer<typeof daemonSetReplicaTierResultSchema>
