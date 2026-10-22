import type { Insertable } from 'kysely'
import type { DatabaseSchema } from './db/schema.js'
import { inTenantTransaction, type TenantScoped } from './db/tenant-database.js'

/**
 * Rows per statement, under SQLite's bound-parameter ceiling (32,766): an
 * insert binds one value per column of a version row plus the tenant stamp —
 * about twenty — and the read-back one per id.
 */
const INSERT_BATCH = 1_000
const READ_BATCH = 10_000

function* batchesOf<T>(items: readonly T[], size: number): Generator<readonly T[]> {
  for (let start = 0; start < items.length; start += size) yield items.slice(start, start + size)
}

/**
 * Carried version rows written under their own ids, and which of them the
 * workspace holds afterwards. In batches, since a promote carries more rows
 * than one statement may bind, and in one transaction, so a batch refused
 * part-way leaves none of the call's rows behind.
 *
 * `inserted` names only the rows this call wrote: an id already held is
 * skipped, so naming one of this keeper's own rows cannot make that row one
 * the automatic cap may take. `held` is read back for THIS workspace, so an id
 * another workspace holds is left out.
 */
export function insertAdoptedRows(
  db: TenantScoped,
  workspaceId: string,
  rows: readonly Insertable<DatabaseSchema['versions']>[],
): Promise<{ inserted: string[]; held: string[] }> {
  return inTenantTransaction(db, async (trx) => {
    const inserted: string[] = []
    const held: string[] = []
    for (const batch of batchesOf(rows, INSERT_BATCH)) {
      const written = await trx
        .insertInto('versions')
        .values([...batch])
        .onConflict((conflict) => conflict.column('id').doNothing())
        .returning('id')
        .execute()
      for (const row of written) inserted.push(row.id)
    }
    for (const batch of batchesOf(rows, READ_BATCH)) {
      const found = await trx
        .selectFrom('versions')
        .select(['id'])
        .where('workspaceId', '=', workspaceId)
        .where(
          'id',
          'in',
          batch.map((row) => row.id),
        )
        .execute()
      for (const row of found) held.push(row.id)
    }
    return { inserted, held }
  })
}
