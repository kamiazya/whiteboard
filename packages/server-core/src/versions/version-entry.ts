import { z } from 'zod'

/**
 * Who saved a version. Declared once, here, because it crosses three
 * boundaries under one shape: the daemon's HTTP save route accepts it, the
 * `version_created` WebSocket message carries it, and the MCP version tools
 * answer with it. `server-core` is the lowest package all three can import.
 */
export const operatorInfoSchema = z.object({
  kind: z.enum(['ai', 'human', 'system']),
  peerId: z.string().min(1),
  displayName: z.string().optional(),
  agentId: z.string().optional(),
  workspaceId: z.string().optional(),
})
export type OperatorInfo = z.infer<typeof operatorInfoSchema>

/**
 * One row of a document's version history, as every surface publishes it —
 * the HTTP list route, the `version_created` broadcast, and the
 * `wb_version_*` tools. The server hydrates missing legacy metadata before
 * answering, so `branchName` is always present on the wire.
 */
export const versionEntrySchema = z.object({
  id: z.string(),
  path: z.string(),
  createdAt: z.string(),
  elementCount: z.number().finite(),
  label: z.string().optional(),
  auto: z.boolean(),
  operator: operatorInfoSchema.optional(),
  branchName: z.string(),
  /**
   * The version this point was produced by RESTORING, when it was.
   *
   * A restore reconciles a past state onto the live document, so what comes
   * out is a descendant of both the state you were on and the one you went
   * back to — a merge. The shape of that is already derivable from the
   * stored frontiers, and the shape is not the part a reader is missing:
   * `cmpFrontiers` can say two points diverged and rejoined, and can never
   * say WHY. This is the merge commit's message.
   */
  restoredFrom: z.string().optional(),
})
export type VersionEntry = z.infer<typeof versionEntrySchema>

/**
 * A version as the MCP tools answer it: what an agent acts on, and nothing
 * the History PANEL needs that an agent does not. `path` repeats the
 * document it asked about, `elementCount` is panel
 * decoration, and `branchName` is the legacy column ADR-0029 retired the
 * branch from (always `main` on the wire). Measured on the errand
 * scoreboard, four saved versions answered 1,948 bytes with them and 1,316
 * without; a model reads that answer in every turn that follows.
 *
 * The operator keeps who and how they are shown, not the peer and agent
 * ids a person never types.
 */
export const versionEntryForAgentSchema = z
  .object({
    id: z.string().describe('The version to restore or name later.'),
    createdAt: z.string(),
    label: z.string().optional(),
    auto: z.boolean().describe('True for an automatic checkpoint, false for one somebody saved.'),
    operator: z
      .object({
        kind: z.enum(['ai', 'human', 'system']),
        displayName: z.string().optional(),
      })
      .strict()
      .optional(),
    restoredFrom: z.string().optional(),
  })
  .strict()
export type VersionEntryForAgent = z.infer<typeof versionEntryForAgentSchema>

export function versionEntryForAgent(entry: VersionEntry): VersionEntryForAgent {
  return {
    id: entry.id,
    createdAt: entry.createdAt,
    ...(entry.label === undefined ? {} : { label: entry.label }),
    auto: entry.auto,
    ...(entry.operator === undefined
      ? {}
      : {
          operator: {
            kind: entry.operator.kind,
            ...(entry.operator.displayName === undefined
              ? {}
              : { displayName: entry.operator.displayName }),
          },
        }),
    ...(entry.restoredFrom === undefined ? {} : { restoredFrom: entry.restoredFrom }),
  }
}
