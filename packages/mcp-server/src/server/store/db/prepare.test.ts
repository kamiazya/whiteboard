import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { saveDaemonRecord } from '../../../daemon/daemon-registry.js'
import { PACKAGE_VERSION } from '../../../shared/package-version.js'
import { readProcessStartMs } from '../../../shared/process-identity.js'
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
  // The parent process is a live neighbour that started before this record.
  const record = (overrides: { pid?: number; version?: string; startedAt?: string }) => ({
    pid: process.ppid,
    token: 'tok',
    version: '0.0.0-older',
    startedAt: new Date().toISOString(),
    socketPath: '/fake/daemon.sock',
    launch: 'source' as const,
    ...overrides,
  })

  async function skewWarnings(overrides: { pid?: number; version?: string; startedAt?: string }) {
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

  // A record dated before its pid's process started was written by a daemon
  // that died; the pid now belongs to whatever took it.
  it.skipIf(readProcessStartMs(process.ppid) === null)(
    'stays quiet for a leftover record whose pid a later process took',
    async () => {
      expect(await skewWarnings({ startedAt: '2024-01-01T00:00:00.000Z' })).toEqual([])
    },
  )

  it('stays quiet for a record this process wrote itself', async () => {
    expect(await skewWarnings({ pid: process.pid })).toEqual([])
  })

  // The record a newer daemon writes is the one this build is likeliest to
  // refuse, and the daemon behind it the likeliest to be of another version.
  it('warns for a live daemon whose record this build cannot interpret', async () => {
    await writeFile(
      join(tempDir, 'daemon.json'),
      JSON.stringify({ ...record({}), version: '9.9.9', launch: 'packaged' }),
    )
    const capture = captureLogsForTests('warning')
    try {
      await prepareDataDir(tempDir)
      const warnings = capture.records.filter((r) => r.data?.recordedVersion !== undefined)
      expect(warnings).toEqual([
        expect.objectContaining({
          data: expect.objectContaining({ pid: process.ppid, recordedVersion: '9.9.9' }),
        }),
      ])
    } finally {
      capture.restore()
    }
  })

  it('warns for a live daemon of another version whose record has no token', async () => {
    const { token: _token, ...tokenless } = record({})
    await writeFile(join(tempDir, 'daemon.json'), JSON.stringify(tokenless))
    const capture = captureLogsForTests('warning')
    try {
      await prepareDataDir(tempDir)
      const warnings = capture.records.filter((r) => r.data?.recordedVersion !== undefined)
      expect(warnings).toEqual([
        expect.objectContaining({
          data: expect.objectContaining({ recordedVersion: '0.0.0-older' }),
        }),
      ])
    } finally {
      capture.restore()
    }
  })

  it('still migrates when the versions differ', async () => {
    await skewWarnings({})
    const db = await getDb(tempDir)
    await expect(db.selectFrom('workspaces').select(['id']).execute()).resolves.toEqual([])
  })
})
