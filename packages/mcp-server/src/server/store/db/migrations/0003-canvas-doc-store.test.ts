import { type Kysely, sql } from 'kysely'
import { describe, expect, it } from 'vitest'
import type { DatabaseSchema } from '../schema.js'
import { openMigrationHarness } from '../test-helpers.js'
import { migration } from './0003-canvas-doc-store.js'

async function createMemoryDb(): Promise<Kysely<DatabaseSchema>> {
  return (await openMigrationHarness<DatabaseSchema>()).db
}

async function tableExists(db: Kysely<DatabaseSchema>, name: string): Promise<boolean> {
  const row = await sql<{
    name: string
  }>`select name from sqlite_master where type = 'table' and name = ${name}`.execute(db)
  return row.rows.length > 0
}

describe('0003-canvas-doc-store migration', () => {
  it('up creates all four tables; down drops them', async () => {
    const db = await createMemoryDb()
    try {
      await migration.up(db as unknown as Kysely<unknown>)

      for (const table of [
        'canvasDocSnapshots',
        'canvasDocSnapshotChunks',
        'canvasDocDeltas',
        'canvasDocFrontiers',
      ]) {
        expect(await tableExists(db, table)).toBe(true)
      }

      await migration.down(db as unknown as Kysely<unknown>)

      for (const table of [
        'canvasDocSnapshots',
        'canvasDocSnapshotChunks',
        'canvasDocDeltas',
        'canvasDocFrontiers',
      ]) {
        expect(await tableExists(db, table)).toBe(false)
      }
    } finally {
      await db.destroy()
    }
  })
})
