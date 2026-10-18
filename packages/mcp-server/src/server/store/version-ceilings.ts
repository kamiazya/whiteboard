import {
  MAX_MANUAL_PER_DOCUMENT,
  MAX_RESTORE_POINTS_PER_DOCUMENT,
} from '@kamiazya/whiteboard-history'
import { TooManyVersionsError } from '@kamiazya/whiteboard-server-core'
import type { TenantDatabase } from './db/tenant-database.js'

/**
 * Throws `TooManyVersionsError` when the document already keeps the most
 * manual versions one document may. Asked before the row is written, so a
 * refusal leaves nothing behind; under the workspace write barrier `save`
 * holds, so two saves racing for the last place cannot both take it.
 */
export async function refusePastManualCeiling(
  db: TenantDatabase,
  workspaceId: string,
  documentId: string,
): Promise<void> {
  const held = await db
    .selectFrom('versions')
    .select((eb) => eb.fn.countAll<number>().as('n'))
    .where('workspaceId', '=', workspaceId)
    .where('documentId', '=', documentId)
    .where('auto', '=', 0)
    .executeTakeFirstOrThrow()
  if (Number(held.n) >= MAX_MANUAL_PER_DOCUMENT) {
    throw new TooManyVersionsError(MAX_MANUAL_PER_DOCUMENT)
  }
}

/**
 * Throws `TooManyVersionsError` when the document already keeps the most
 * restore merge points one document may. Neither retention pass retires
 * lineage, so this ceiling is the only bound a restore loop meets; the
 * restore's caller records its point best-effort, so the content still lands.
 */
export async function refusePastRestorePointCeiling(
  db: TenantDatabase,
  workspaceId: string,
  documentId: string,
): Promise<void> {
  const held = await db
    .selectFrom('versions')
    .select((eb) => eb.fn.countAll<number>().as('n'))
    .where('workspaceId', '=', workspaceId)
    .where('documentId', '=', documentId)
    .where('restoredFrom', 'is not', null)
    .executeTakeFirstOrThrow()
  if (Number(held.n) >= MAX_RESTORE_POINTS_PER_DOCUMENT) {
    throw new TooManyVersionsError(MAX_RESTORE_POINTS_PER_DOCUMENT)
  }
}
