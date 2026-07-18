import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getDaemonRecordPath } from './daemon-registry.js'
import { parseDaemonRecord } from './daemon-record.js'

describe('parseDaemonRecord', () => {
  let dataDir: string

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'daemon-record-test-'))
  })

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true })
  })

  it('returns "missing" when daemon.json does not exist', async () => {
    const result = await parseDaemonRecord(dataDir)

    expect(result).toEqual({ kind: 'missing' })
  })

  it('returns "malformed" for invalid JSON', async () => {
    await writeFile(getDaemonRecordPath(dataDir), '{ not valid json', 'utf-8')

    const result = await parseDaemonRecord(dataDir)

    expect(result.kind).toBe('malformed')
  })

  it('returns "malformed" when the JSON is not an object', async () => {
    await writeFile(getDaemonRecordPath(dataDir), JSON.stringify('not-an-object'), 'utf-8')

    const result = await parseDaemonRecord(dataDir)

    expect(result).toEqual({
      kind: 'malformed',
      message: 'Daemon record is not an object.',
    })
  })

  it('returns "malformed" when required base fields are missing', async () => {
    await writeFile(getDaemonRecordPath(dataDir), JSON.stringify({ pid: 123 }), 'utf-8')

    const result = await parseDaemonRecord(dataDir)

    expect(result).toEqual({
      kind: 'malformed',
      message: 'Daemon record is missing required fields.',
    })
  })

  it('returns "token-missing" with the base record when the token is absent', async () => {
    const base = {
      pid: 123,
      port: 3099,
      version: '0.1.0',
      startedAt: '2026-04-23T00:00:00.000Z',
    }
    await writeFile(getDaemonRecordPath(dataDir), JSON.stringify(base), 'utf-8')

    const result = await parseDaemonRecord(dataDir)

    expect(result).toEqual({ kind: 'token-missing', record: base })
  })

  it('returns "token-missing" when the token is present but empty', async () => {
    const base = {
      pid: 123,
      port: 3099,
      version: '0.1.0',
      startedAt: '2026-04-23T00:00:00.000Z',
      token: '',
    }
    await writeFile(getDaemonRecordPath(dataDir), JSON.stringify(base), 'utf-8')

    const result = await parseDaemonRecord(dataDir)

    expect(result.kind).toBe('token-missing')
  })

  it('returns "valid" with the full record when all fields including token parse', async () => {
    const record = {
      pid: 123,
      port: 3099,
      version: '0.1.0',
      startedAt: '2026-04-23T00:00:00.000Z',
      token: 'secret',
    }
    await writeFile(getDaemonRecordPath(dataDir), JSON.stringify(record), 'utf-8')

    const result = await parseDaemonRecord(dataDir)

    expect(result).toEqual({ kind: 'valid', record })
  })
})
