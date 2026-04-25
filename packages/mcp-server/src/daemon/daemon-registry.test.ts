import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

  it('returns null for malformed daemon.json content', async () => {
    await writeFile(getDaemonRecordPath(dataDir), '{"pid":"oops"}')
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
