import type { OperatorInfo } from '@kamiazya/whiteboard-daemon-client/api-contracts/document'
import type { Insertable } from 'kysely'
import type { DatabaseSchema } from './db/schema.js'

/** What `save` takes beyond the document itself. */
export interface SaveVersionOpts {
  auto: boolean
  label?: string
  operator?: OperatorInfo
  /** The version this point was produced by restoring; see `versionEntrySchema`. */
  restoredFrom?: string
}

/**
 * The row a saved version becomes. Every optional field is written as NULL
 * rather than omitted, because the column exists either way.
 */
export function versionRow({
  id,
  documentId,
  workspaceId,
  opts,
  operator,
  elementCount,
  frontiers,
  contentDigest,
  createdAt,
}: {
  id: string
  documentId: string
  workspaceId: string
  opts: SaveVersionOpts
  operator: SaveVersionOpts['operator']
  elementCount: number
  frontiers: string
  contentDigest: string
  createdAt: number
}): Insertable<DatabaseSchema['versions']> {
  return {
    id,
    documentId,
    workspaceId,
    auto: opts.auto ? 1 : 0,
    label: opts.label ?? null,
    operatorKind: operator?.kind ?? '',
    operatorActor: operator?.actor ?? '',
    operatorDisplayName: operator?.displayName ?? null,
    operatorAgentId: operator?.agentId ?? null,
    operatorWorkspaceId: operator?.workspaceId ?? null,
    elementCount,
    frontiers,
    contentDigest,
    createdAt,
    restoredFrom: opts.restoredFrom ?? null,
    // Nothing saves a version with a person's evidence; the column is kept
    // for the rows that already carry one, which `rowToEntry` still reads.
    attestation: null,
  }
}
