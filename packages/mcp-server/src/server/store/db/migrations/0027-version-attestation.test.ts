/**
 * The attestation column is ADDITIVE: a row written before it is kept, and
 * reads back with no attestation. That is the opposite of 0026's posture, and
 * deliberately — a checkpoint that predates the column was never asked for
 * evidence (ADR-0039 decision 5: absence means "not asked"), so it is exactly
 * as true after the migration as before. Pinned against a real pre-migration
 * row so a later "clean it up" cannot quietly take saved points with it.
 */
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type Kysely, sql } from 'kysely'
import { beforeEach, expect, it, vi } from 'vitest'
import { type MigrationHarness, openMigrationHarness } from '../test-helpers.js'

let dataDir = ''
vi.mock('../../../config.js', () => ({
  get DATA_DIR() {
    return dataDir
  },
  getDataDir: () => dataDir,
}))

const PRE_0027 = '0026-version-content-digest'

type Db = Kysely<Record<string, Record<string, unknown>>>

async function openDb(): Promise<MigrationHarness> {
  return openMigrationHarness(dataDir)
}

async function versionColumns(db: Db): Promise<string[]> {
  const rows = await sql<{ name: string }>`select name from pragma_table_info('versions')`.execute(
    db,
  )
  return rows.rows.map((r) => r.name)
}

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'version-attestation-'))
})

it('keeps a checkpoint that predates the column, reading it back with no attestation', async () => {
  const handle = await openDb()
  await handle.migrateTo(PRE_0027)
  expect(await versionColumns(handle.db)).not.toContain('attestation')
  await handle.db
    .insertInto('versions')
    .values({
      id: 'v-1',
      documentId: 'doc-1',
      workspaceId: 'ws-1',
      branchName: 'main',
      auto: 0,
      label: 'a point',
      operatorKind: 'human',
      operatorActor: '',
      elementCount: 3,
      frontiers: 'ZnJvbnRpZXJz',
      contentDigest: 'digest-1',
      createdAt: Date.now(),
    })
    .execute()

  await handle.migrateToHead()

  expect(await versionColumns(handle.db)).toContain('attestation')
  const rows = await handle.db
    .selectFrom('versions')
    .select(['id', 'label', 'attestation'])
    .execute()
  expect(rows).toEqual([{ id: 'v-1', label: 'a point', attestation: null }])
})
