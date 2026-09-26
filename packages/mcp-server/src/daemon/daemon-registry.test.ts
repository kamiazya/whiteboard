import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CAN_DENY_FILE_READ } from '../shared/test-utils/can-deny-file-read.js'
import {
  deleteDaemonRecord,
  getDaemonRecordPath,
  isPidAlive,
  loadDaemonRecord,
  saveDaemonRecord,
} from './daemon-registry.js'

describe('daemon-registry', () => {
  let dataDir: string

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'excalidraw-daemon-registry-'))
  })

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true })
  })

  it('saves and loads daemon.json records', async () => {
    await saveDaemonRecord(
      {
        pid: 123,
        port: 3099,
        token: 'secret',
        version: '0.1.0',
        startedAt: '2026-04-23T00:00:00.000Z',
      },
      dataDir,
    )

    await expect(loadDaemonRecord(dataDir)).resolves.toEqual({
      pid: 123,
      port: 3099,
      token: 'secret',
      version: '0.1.0',
      startedAt: '2026-04-23T00:00:00.000Z',
    })
  })

  it.skipIf(!CAN_DENY_FILE_READ)(
    'throws for a daemon.json it cannot READ, rather than answering none is running',
    async () => {
      // ensure-daemon answers null by deleting the record and spawning a new
      // daemon with a new token. For a record that was merely unreadable,
      // that orphans the daemon that is still running under it.
      await saveDaemonRecord(
        {
          pid: 123,
          port: 3099,
          token: 'secret',
          version: '0.1.0',
          startedAt: '2026-04-23T00:00:00.000Z',
        },
        dataDir,
      )
      const path = getDaemonRecordPath(dataDir)
      await chmod(path, 0o000)
      try {
        await expect(loadDaemonRecord(dataDir)).rejects.toThrow(/daemon\.json|daemon record/i)
      } finally {
        await chmod(path, 0o600)
      }
    },
  )

  it('returns null when there is no daemon.json at all', async () => {
    await expect(loadDaemonRecord(dataDir)).resolves.toBeNull()
  })

  it('returns null for malformed daemon.json content', async () => {
    await writeFile(getDaemonRecordPath(dataDir), '{"pid":"oops"}')
    await expect(loadDaemonRecord(dataDir)).resolves.toBeNull()
  })

  it('returns null for a daemon.json with an empty-string token (fail-closed)', async () => {
    await writeFile(
      getDaemonRecordPath(dataDir),
      JSON.stringify({
        pid: 123,
        port: 3099,
        token: '',
        version: '0.1.0',
        startedAt: '2026-04-23T00:00:00.000Z',
      }),
    )
    await expect(loadDaemonRecord(dataDir)).resolves.toBeNull()
  })

  it('returns null for a daemon.json with a missing token', async () => {
    await writeFile(
      getDaemonRecordPath(dataDir),
      JSON.stringify({
        pid: 123,
        port: 3099,
        version: '0.1.0',
        startedAt: '2026-04-23T00:00:00.000Z',
      }),
    )
    await expect(loadDaemonRecord(dataDir)).resolves.toBeNull()
  })

  it('writes atomically via a temp file that does not remain afterwards', async () => {
    await saveDaemonRecord(
      {
        pid: 321,
        port: 4242,
        token: 'abc',
        version: '0.2.0',
        startedAt: '2026-04-23T00:00:00.000Z',
      },
      dataDir,
    )

    const contents = await readFile(getDaemonRecordPath(dataDir), 'utf-8')
    expect(JSON.parse(contents)).toMatchObject({ pid: 321, port: 4242 })
    await expect(readFile(`${getDaemonRecordPath(dataDir)}.tmp`, 'utf-8')).rejects.toThrow()
  })

  it('deletes daemon.json if present', async () => {
    await saveDaemonRecord(
      {
        pid: 1,
        port: 2,
        token: 't',
        version: 'v',
        startedAt: '2026-04-23T00:00:00.000Z',
      },
      dataDir,
    )

    await deleteDaemonRecord(dataDir)
    await expect(loadDaemonRecord(dataDir)).resolves.toBeNull()
  })
})

describe('isPidAlive', () => {
  it('treats the current pid as alive', () => {
    expect(isPidAlive(process.pid)).toBe(true)
  })

  it('treats impossible pid values as dead', () => {
    expect(isPidAlive(0)).toBe(false)
    expect(isPidAlive(-1)).toBe(false)
    expect(isPidAlive(Number.NaN)).toBe(false)
    expect(isPidAlive(999_999_999)).toBe(false)
  })
})
