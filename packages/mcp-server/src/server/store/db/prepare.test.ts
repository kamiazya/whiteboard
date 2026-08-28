import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { closeDb, getDb } from './index.js'
import { runMigrations } from './migrator.js'
import { clearPrepareCache, prepareDataDir } from './prepare.js'

vi.mock('./migrator.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./migrator.js')>()
  return { ...actual, runMigrations: vi.fn(actual.runMigrations) }
})

let tempDir: string

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'whiteboard-prepare-test-'))
})

afterEach(async () => {
  await closeDb(tempDir)
  clearPrepareCache()
  await rm(tempDir, { recursive: true, force: true })
  vi.mocked(runMigrations).mockClear()
})

describe('prepareDataDir', () => {
  it('applies migrations to a fresh dataDir', async () => {
    await prepareDataDir(tempDir)
    const db = await getDb(tempDir)
    // A migrated db has the workspaces table (from 0001-init); the raw
    // Kysely handle answering the query without throwing is the pin.
    await expect(db.selectFrom('workspaces').select(['id']).execute()).resolves.toEqual([])
  })

  it('memoizes: a second call for the same dataDir does not re-run migrations', async () => {
    await prepareDataDir(tempDir)
    expect(vi.mocked(runMigrations)).toHaveBeenCalledTimes(1)
    await prepareDataDir(tempDir)
    expect(vi.mocked(runMigrations)).toHaveBeenCalledTimes(1)
  })

  it('retries on the next call after a failure', async () => {
    vi.mocked(runMigrations).mockRejectedValueOnce(new Error('boom'))
    await expect(prepareDataDir(tempDir)).rejects.toThrow('boom')
    await expect(prepareDataDir(tempDir)).resolves.toBeUndefined()
    expect(vi.mocked(runMigrations)).toHaveBeenCalledTimes(2)
  })
})
