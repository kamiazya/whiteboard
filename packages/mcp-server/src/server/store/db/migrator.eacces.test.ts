/**
 * A migration that walks the data directory can fail on permissions rather
 * than on the database, and what the person reads then is the difference
 * between a path to a fix and an errno naming a call they never made.
 */
import { Kysely, SqliteDialect } from 'kysely'
import LibsqlNativeDatabase from 'libsql'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runMigrations } from './migrator.js'
import type { Database, DatabaseSchema } from './schema.js'

const thrown = vi.hoisted(() => ({ error: undefined as unknown }))

// The provider is private to the migrator, so the migration list it ships is
// replaced by one that fails the way a blob walk does.
vi.mock('./migrations/index.js', () => ({
  migrations: {
    '0001-walks-the-blobs': {
      up: async () => {
        throw thrown.error
      },
    },
  },
}))

let db: Database | undefined
afterEach(async () => {
  await db?.destroy()
  db = undefined
})

function openDb(): Database {
  db = new Kysely<DatabaseSchema>({
    dialect: new SqliteDialect({
      database: new LibsqlNativeDatabase(':memory:') as unknown as ConstructorParameters<
        typeof SqliteDialect
      >[0]['database'],
    }),
  })
  return db
}

describe('runMigrations on a permission error', () => {
  it('names the data directory and the migration instead of the raw errno', async () => {
    const errno = Object.assign(new Error("EACCES: permission denied, scandir '/data/blobs'"), {
      code: 'EACCES',
    })
    thrown.error = errno

    const failure = await runMigrations(openDb()).catch((err: unknown) => err)

    expect(failure).toBeInstanceOf(Error)
    const message = (failure as Error).message
    expect(message).toMatch(
      /^Database migration failed at 0001-walks-the-blobs: permission denied reading the data directory/,
    )
    expect(message).not.toContain('scandir')
    expect((failure as Error).cause).toBe(errno)
  })

  it('keeps the underlying message for any other failure', async () => {
    thrown.error = Object.assign(new Error('disk I/O error'), { code: 'EIO' })

    const failure = await runMigrations(openDb()).catch((err: unknown) => err)

    expect((failure as Error).message).toBe(
      'Database migration failed at 0001-walks-the-blobs: disk I/O error',
    )
  })
})
