/**
 * The version row's lane label goes with the branch it named. The column is
 * named by the `(documentId, branchName, createdAt)` index, which SQLite
 * refuses to leave dangling, so this pins that the rows survive the column
 * and that the history lookup keeps an index over the columns it still reads.
 */
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sql } from 'kysely'
import { beforeEach, expect, it, vi } from 'vitest'
import { openMigrationHarness } from '../test-helpers.js'

let dataDir = ''
vi.mock('../../../config.js', () => ({
  get DATA_DIR() {
    return dataDir
  },
  getDataDir: () => dataDir,
}))

const PRE_0041 = '0040-drop-invitation-email'

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'wb-0041-'))
})

it('removes branchName and the index that named it, keeping a document-history index', async () => {
  const { db, migrateTo, migrateToHead } = await openMigrationHarness(dataDir)
  await migrateTo(PRE_0041)
  const before = await sql<{ name: string }>`
    select name from pragma_table_info('versions')
  `.execute(db)
  expect(before.rows.map((r) => r.name)).toContain('branchName')

  await migrateToHead()
  const columns = await sql<{ name: string }>`
    select name from pragma_table_info('versions')
  `.execute(db)
  expect(columns.rows.map((r) => r.name)).not.toContain('branchName')

  const indexed = await sql<{ idx: string; col: string }>`
    select l.name as idx, i.name as col
    from pragma_index_list('versions') l, pragma_index_info(l.name) i
  `.execute(db)
  expect(indexed.rows.map((r) => r.col)).not.toContain('branchName')
  const documentIndexColumns = indexed.rows
    .filter((r) => r.idx === 'versions_document_idx')
    .map((r) => r.col)
  expect(documentIndexColumns).toEqual(['documentId', 'createdAt'])
  expect(indexed.rows.map((r) => r.idx)).toContain('versions_workspace_id')
  await db.destroy()
})

it('keeps every version row, whatever lane label it carried', async () => {
  const { db, migrateTo, migrateToHead } = await openMigrationHarness(dataDir)
  await migrateTo(PRE_0041)
  await sql`
    insert into workspaces (id, displayName, createdAt, updatedAt) values ('ws-1', null, 1, 1)
  `.execute(db)
  await sql`
    insert into versions
      (id, documentId, workspaceId, branchName, auto, label, operatorKind, operatorActor,
       elementCount, frontiers, contentDigest, createdAt)
    values
      ('v-main', 'doc-1', 'ws-1', 'main', 0, 'kept', 'human', 'p-ada', 3, 'f1', 'd1', 10),
      ('v-other', 'doc-1', 'ws-1', 'feature', 1, null, '', '', 4, 'f2', 'd2', 20)
  `.execute(db)
  await migrateToHead()
  const rows = await sql<{ id: string; label: string | null; createdAt: number }>`
    select id, label, createdAt from versions order by id
  `.execute(db)
  expect(rows.rows).toEqual([
    { id: 'v-main', label: 'kept', createdAt: 10 },
    { id: 'v-other', label: null, createdAt: 20 },
  ])
  await db.destroy()
})
