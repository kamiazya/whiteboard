import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { LibsqlDialect } from '@libsql/kysely-libsql'
import { Kysely } from 'kysely'
import { DATA_DIR } from '../../config.js'
import type { DatabaseSchema } from './schema.js'

export type Database = Kysely<DatabaseSchema>

export const DB_FILENAME = 'whiteboard.db'

// One Kysely instance per DATA_DIR. Tests swap DATA_DIR via vi.mock so multiple
// distinct DBs may be opened across the lifetime of the process; each gets its
// own cache entry. Production only ever sees one DATA_DIR.
const cache = new Map<string, Database>()

function buildDb(dataDir: string): Database {
  const url = `file:${join(dataDir, DB_FILENAME)}`
  return new Kysely<DatabaseSchema>({
    dialect: new LibsqlDialect({ url }),
  })
}

export async function getDb(dataDir: string = DATA_DIR): Promise<Database> {
  const existing = cache.get(dataDir)
  if (existing) return existing
  await mkdir(dataDir, { recursive: true })
  const db = buildDb(dataDir)
  cache.set(dataDir, db)
  return db
}

export async function closeDb(dataDir: string = DATA_DIR): Promise<void> {
  const db = cache.get(dataDir)
  if (!db) return
  cache.delete(dataDir)
  await db.destroy()
}

// Tests mutate DATA_DIR via vi.mock; clearDbCache removes every cached instance
// without awaiting destroy() so the test setup can swap DATA_DIR without leaking
// connections. Production code should prefer closeDb() to release the underlying
// libsql connection cleanly.
export function clearDbCache(): void {
  for (const db of cache.values()) {
    void db.destroy().catch(() => {})
  }
  cache.clear()
}
