/**
 * A migration test opens its database through `openMigrationHarness`, never
 * by building the native driver and its dialect itself — and the harness
 * itself behaves the way those tests rely on.
 *
 * The construction needs a cast the type system cannot check (libsql's
 * `Database` is better-sqlite3-shaped, not better-sqlite3), plus the foreign
 * key pragma and a migrator over the real provider. It was copied into
 * nearly every migration test, and a copy that drops the pragma or points the
 * migrator at a different provider tests a database production never has.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { access, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { sql } from 'kysely'
import { describe, expect, it } from 'vitest'
import { openMigrationHarness } from '../test-helpers.js'

const MIGRATIONS_DIR = import.meta.dirname
const THIS_FILE = import.meta.filename.slice(MIGRATIONS_DIR.length + 1)

const MIGRATION_TEST_FILES = [
  ...readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith('.test.ts') && name !== THIS_FILE)
    .map((name) => join(MIGRATIONS_DIR, name)),
  // The one test outside the directory that replays the migration log.
  join(MIGRATIONS_DIR, '..', 'migrator.legacy-upgrade.test.ts'),
]

/** What building the driver by hand looks like, in each of its parts. */
const HAND_BUILT = /LibsqlNativeDatabase|from 'libsql'|new SqliteDialect/

describe('migration tests share one database harness', () => {
  it('scans the migration test files', () => {
    // An empty scan agrees with every rule; the count is what keeps it honest.
    expect(MIGRATION_TEST_FILES.length).toBeGreaterThan(25)
  })

  it('no migration test builds the native driver or its dialect itself', () => {
    const offenders = MIGRATION_TEST_FILES.filter((path) =>
      HAND_BUILT.test(readFileSync(path, 'utf8')),
    ).map((path) => relative(MIGRATIONS_DIR, path))
    expect(offenders).toEqual([])
  })
})

describe('openMigrationHarness', () => {
  it('stops at the migration it is told to and applies the rest on demand', async () => {
    const { db, migrateTo, migrateToHead } = await openMigrationHarness()
    try {
      await migrateTo('0001-init')
      const early = await sql<{ n: number }>`select count(*) as n from sqlite_master`.execute(db)
      await migrateToHead()
      const late = await sql<{ n: number }>`select count(*) as n from sqlite_master`.execute(db)
      expect(late.rows[0]?.n).toBeGreaterThan(early.rows[0]?.n ?? Number.POSITIVE_INFINITY)
    } finally {
      await db.destroy()
    }
  })

  it('throws the migration error rather than reporting success', async () => {
    const { db, migrateTo } = await openMigrationHarness()
    try {
      await expect(migrateTo('9999-no-such-migration')).rejects.toBeDefined()
    } finally {
      await db.destroy()
    }
  })

  it('hands the error back from migrateToHeadRaw, and undefined when the log applies', async () => {
    const { db, migrateToHeadRaw } = await openMigrationHarness()
    try {
      expect(await migrateToHeadRaw()).toBeUndefined()
    } finally {
      await db.destroy()
    }
  })

  it('opens the whiteboard.db file in the data dir it is given', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'wb-harness-'))
    const onDisk = await openMigrationHarness(dataDir)
    try {
      await onDisk.migrateToHead()
      await expect(access(join(dataDir, 'whiteboard.db'))).resolves.toBeUndefined()
    } finally {
      await onDisk.db.destroy()
    }
  })
})
