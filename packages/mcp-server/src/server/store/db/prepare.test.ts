import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { saveDaemonRecord } from '../../../daemon/daemon-registry.js'
import { PACKAGE_VERSION } from '../../../shared/package-version.js'
import { captureLogsForTests } from '../../log.js'
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

describe('prepareDataDir: daemon version skew', () => {
  const record = (overrides: { pid?: number; version?: string }) => ({
    pid: process.ppid,
    token: 'tok',
    version: '0.0.0-older',
    startedAt: '2024-01-01T00:00:00.000Z',
    socketPath: '/fake/daemon.sock',
    ...overrides,
  })

  async function skewWarnings(overrides: { pid?: number; version?: string }) {
    await saveDaemonRecord(record(overrides), tempDir)
    const capture = captureLogsForTests('warning')
    try {
      await prepareDataDir(tempDir)
      return capture.records.filter((r) => r.data?.recordedVersion !== undefined)
    } finally {
      capture.restore()
    }
  }

  it('warns, naming both versions, when a live daemon of another version holds the data dir', async () => {
    const [warning, ...rest] = await skewWarnings({})
    expect(rest).toEqual([])
    expect(warning?.data).toMatchObject({
      recordedVersion: '0.0.0-older',
      runningVersion: PACKAGE_VERSION,
      dataDir: tempDir,
    })
    expect(warning?.msg).toContain('0.0.0-older')
    expect(warning?.msg).toContain(PACKAGE_VERSION)
  })

  it('stays quiet when the recorded version is the running build', async () => {
    expect(await skewWarnings({ version: PACKAGE_VERSION })).toEqual([])
  })

  it('stays quiet for a leftover record whose process is gone', async () => {
    expect(await skewWarnings({ pid: 2_147_483_646 })).toEqual([])
  })

  it('stays quiet for a record this process wrote itself', async () => {
    expect(await skewWarnings({ pid: process.pid })).toEqual([])
  })

  it('still migrates when the versions differ', async () => {
    await skewWarnings({})
    const db = await getDb(tempDir)
    await expect(db.selectFrom('workspaces').select(['id']).execute()).resolves.toEqual([])
  })
})
