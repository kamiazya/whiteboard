// Contract tests for createIsolatedDb. Production store tests opt in to the
// in-memory libsql path; this file pins down the helper itself so a refactor
// of the URL trick (or the cache injection) cannot silently break every store
// suite at once.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sql } from 'kysely'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { closeDb, getDb, clearDbCache } from './index.js'
import { createIsolatedDb } from './test-helpers.js'

let scratch: string

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'createIsolatedDb-test-'))
  clearDbCache()
})

afterEach(async () => {
  clearDbCache()
  await rm(scratch, { recursive: true, force: true })
})

describe('createIsolatedDb (memory)', () => {
  it('runs migrations and exposes a working schema', async () => {
    const handle = await createIsolatedDb({ dataDir: scratch, memory: true })
    try {
      // workspaces table is the first migration; if migrations did not run,
      // this insert would throw "no such table".
      await handle.db
        .insertInto('workspaces')
        .values({ id: 'session-1', createdAt: 1, updatedAt: 1 })
        .execute()
      const rows = await handle.db.selectFrom('workspaces').select('id').execute()
      expect(rows.map((r) => r.id)).toEqual(['session-1'])
    } finally {
      await handle.dispose()
    }
  })

  it('enables PRAGMA foreign_keys so application-side FKs are enforced', async () => {
    const handle = await createIsolatedDb({ dataDir: scratch, memory: true })
    try {
      const pragma = await sql<{ foreign_keys: number }>`PRAGMA foreign_keys`
        .execute(handle.db)
      expect(pragma.rows[0]?.foreign_keys).toBe(1)
    } finally {
      await handle.dispose()
    }
  })

  it('plumbs the helper DB into getDb(dataDir) so production code finds the same instance', async () => {
    const handle = await createIsolatedDb({ dataDir: scratch, memory: true })
    try {
      const fromCache = await getDb(scratch)
      expect(fromCache).toBe(handle.db)
    } finally {
      await handle.dispose()
    }
  })

  it('isolates tests: two helpers with different dataDirs do not share rows', async () => {
    const otherDir = await mkdtemp(join(tmpdir(), 'createIsolatedDb-other-'))
    const a = await createIsolatedDb({ dataDir: scratch, memory: true })
    const b = await createIsolatedDb({ dataDir: otherDir, memory: true })
    try {
      await a.db.insertInto('workspaces').values({ id: 'a', createdAt: 1, updatedAt: 1 }).execute()
      await b.db.insertInto('workspaces').values({ id: 'b', createdAt: 1, updatedAt: 1 }).execute()
      const aRows = await a.db.selectFrom('workspaces').select('id').execute()
      const bRows = await b.db.selectFrom('workspaces').select('id').execute()
      expect(aRows.map((r) => r.id)).toEqual(['a'])
      expect(bRows.map((r) => r.id)).toEqual(['b'])
    } finally {
      await a.dispose()
      await b.dispose()
      await rm(otherDir, { recursive: true, force: true })
    }
  })

  it('dispose() removes the entry so getDb after dispose builds a fresh DB on disk', async () => {
    const handle = await createIsolatedDb({ dataDir: scratch, memory: true })
    await handle.dispose()
    // getDb without an injected helper falls back to the file-backed default
    // (`whiteboard.db`). Calling closeDb releases the connection so the temp
    // dir cleanup in afterEach can remove the file without an EBUSY race.
    const fresh = await getDb(scratch)
    expect(fresh).not.toBe(handle.db)
    await closeDb(scratch)
  })
})

describe('createIsolatedDb (file fallback)', () => {
  it('writes whiteboard.db on disk when memory:false is requested', async () => {
    const handle = await createIsolatedDb({ dataDir: scratch, memory: false })
    try {
      await handle.db
        .insertInto('workspaces')
        .values({ id: 's', createdAt: 1, updatedAt: 1 })
        .execute()
      const fs = await import('node:fs/promises')
      const exists = await fs
        .stat(join(scratch, 'whiteboard.db'))
        .then(() => true)
        .catch(() => false)
      expect(exists).toBe(true)
    } finally {
      await handle.dispose()
    }
  })
})
