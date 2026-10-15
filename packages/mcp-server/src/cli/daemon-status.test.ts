import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { answeringDaemonSocket } from '../daemon/_test-daemon-socket.js'
import { CHMOD_IS_OBSERVABLE } from '../shared/test-utils/chmod-is-observable.js'
import { runDaemonStatus } from './daemon-status.js'

// Tests inject isPidAlive and processStartMs, so no real process decides an
// answer; all but the last describe inject parseRecord too.

const validRecord = {
  pid: 12345,
  socketPath: '/run/user/1000/whiteboard/d.sock',
  version: '1.2.3',
  startedAt: '2024-06-01T00:00:00.000Z',
  token: 'tok',
}

describe('runDaemonStatus: record missing', () => {
  it('returns exitCode 1 and ok=false', async () => {
    const { result, exitCode } = await runDaemonStatus({
      dataDir: '/fake',
      parseRecord: async () => ({ kind: 'missing' }),
      isPidAlive: () => false,
    })
    expect(exitCode).toBe(1)
    expect(result.ok).toBe(false)
  })

  it('sets reason to record-not-found and recordFound=false', async () => {
    const { result } = await runDaemonStatus({
      dataDir: '/fake',
      parseRecord: async () => ({ kind: 'missing' }),
      isPidAlive: () => false,
    })
    expect(result.reason).toBe('record-not-found')
    expect(result.recordFound).toBe(false)
    expect(result.recordFresh).toBe(false)
  })

  it('schemaVersion is 1', async () => {
    const { result } = await runDaemonStatus({
      dataDir: '/fake',
      parseRecord: async () => ({ kind: 'missing' }),
      isPidAlive: () => false,
    })
    expect(result.schemaVersion).toBe(1)
  })
})

describe('runDaemonStatus: record malformed', () => {
  it('returns exitCode 1, ok=false, reason=record-malformed', async () => {
    const { result, exitCode } = await runDaemonStatus({
      dataDir: '/fake',
      parseRecord: async () => ({ kind: 'malformed', message: 'not json' }),
      isPidAlive: () => false,
    })
    expect(exitCode).toBe(1)
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('record-malformed')
    expect(result.recordFound).toBe(true)
    expect(result.recordFresh).toBe(false)
  })
})

describe('runDaemonStatus: token missing', () => {
  it('returns exitCode 1, ok=false, reason=record-token-missing', async () => {
    const tokenMissingRecord = {
      pid: validRecord.pid,
      socketPath: validRecord.socketPath,
      version: validRecord.version,
      startedAt: validRecord.startedAt,
    }
    const { result, exitCode } = await runDaemonStatus({
      dataDir: '/fake',
      parseRecord: async () => ({
        kind: 'token-missing',
        record: tokenMissingRecord,
        liveness: { state: 'dead' },
      }),
      isPidAlive: () => false,
    })
    expect(exitCode).toBe(1)
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('record-token-missing')
    expect(result.recordFound).toBe(true)
    expect(result.recordFresh).toBe(false)
  })

  it('includes record fields in result', async () => {
    const tokenMissingRecord = {
      pid: 42,
      socketPath: '/run/user/1000/whiteboard/d.sock',
      version: '0.1.0',
      startedAt: '2024-01-01T00:00:00.000Z',
    }
    const { result } = await runDaemonStatus({
      dataDir: '/fake',
      parseRecord: async () => ({
        kind: 'token-missing',
        record: tokenMissingRecord,
        liveness: { state: 'dead' },
      }),
      isPidAlive: () => false,
    })
    expect(result.record?.pid).toBe(42)
    expect(result.record?.version).toBe('0.1.0')
  })
})

describe('runDaemonStatus: valid record, process dead', () => {
  it('returns exitCode 1, ok=false, reason=process-not-running', async () => {
    const { result, exitCode } = await runDaemonStatus({
      dataDir: '/fake',
      parseRecord: async () => ({ kind: 'valid', record: validRecord }),
      isPidAlive: () => false,
    })
    expect(exitCode).toBe(1)
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('process-not-running')
    expect(result.pidAlive).toBe(false)
    expect(result.recordFound).toBe(true)
    expect(result.recordFresh).toBe(false)
  })

  it('includes record fields when process is dead', async () => {
    const { result } = await runDaemonStatus({
      dataDir: '/fake',
      parseRecord: async () => ({ kind: 'valid', record: validRecord }),
      isPidAlive: () => false,
    })
    expect(result.record?.pid).toBe(validRecord.pid)
    expect(result.record?.version).toBe(validRecord.version)
  })
})

describe('runDaemonStatus: valid record, process alive', () => {
  it('returns exitCode 0 and ok=true', async () => {
    const { result, exitCode } = await runDaemonStatus({
      dataDir: '/fake',
      parseRecord: async () => ({ kind: 'valid', record: validRecord }),
      isPidAlive: () => true,
      processStartMs: () => null,
    })
    expect(exitCode).toBe(0)
    expect(result.ok).toBe(true)
  })

  it('sets reason=null, recordFresh=true, pidAlive=true', async () => {
    const { result } = await runDaemonStatus({
      dataDir: '/fake',
      parseRecord: async () => ({ kind: 'valid', record: validRecord }),
      isPidAlive: () => true,
      processStartMs: () => null,
    })
    expect(result.reason).toBeNull()
    expect(result.recordFresh).toBe(true)
    expect(result.pidAlive).toBe(true)
  })

  it('includes record fields when healthy', async () => {
    const { result } = await runDaemonStatus({
      dataDir: '/fake',
      parseRecord: async () => ({ kind: 'valid', record: validRecord }),
      isPidAlive: () => true,
      processStartMs: () => null,
    })
    expect(result.record).toEqual({
      pid: validRecord.pid,
      version: validRecord.version,
      startedAt: validRecord.startedAt,
    })
  })
})

describe('runDaemonStatus: valid record, its pid taken by a later process', () => {
  it('reports the daemon not running', async () => {
    const { result, exitCode } = await runDaemonStatus({
      dataDir: '/fake',
      parseRecord: async () => ({ kind: 'valid', record: validRecord }),
      isPidAlive: () => true,
      processStartMs: () => Date.parse(validRecord.startedAt) + 60_000,
    })
    expect(exitCode).toBe(1)
    expect(result).toMatchObject({
      ok: false,
      reason: 'pid-reused',
      recordFresh: false,
      pidAlive: true,
    })
    expect(result).not.toHaveProperty('pingOk')
    expect(result).not.toHaveProperty('servingPid')
  })
})

// A forward wall-clock step moves /proc/stat's btime and not a process's start
// ticks, so a live daemon can read as having started after its own record.
describe('runDaemonStatus: a live daemon after the wall clock stepped forward', () => {
  const steppedStart = () => Date.parse(validRecord.startedAt) + 6_000

  it('reports the daemon running when its socket names the recorded pid', async () => {
    const daemon = await answeringDaemonSocket(validRecord.pid, validRecord.token)
    const { result, exitCode } = await runDaemonStatus({
      dataDir: '/fake',
      parseRecord: async () => ({
        kind: 'valid',
        record: { ...validRecord, socketPath: daemon.socketPath },
      }),
      isPidAlive: () => true,
      processStartMs: steppedStart,
    })
    expect(result).toMatchObject({ ok: true, reason: null, pidAlive: true })
    expect(exitCode).toBe(0)
  })

  it('names the pid that answered on the socket instead, and claims no ping', async () => {
    const daemon = await answeringDaemonSocket(validRecord.pid + 1, validRecord.token)
    const { result } = await runDaemonStatus({
      dataDir: '/fake',
      parseRecord: async () => ({
        kind: 'valid',
        record: { ...validRecord, socketPath: daemon.socketPath },
      }),
      isPidAlive: () => true,
      processStartMs: steppedStart,
    })
    expect(result).toEqual({
      schemaVersion: 1,
      ok: false,
      reason: 'identity-unconfirmed',
      recordFound: true,
      recordFresh: false,
      pidAlive: true,
      servingPid: validRecord.pid + 1,
      record: {
        pid: validRecord.pid,
        version: validRecord.version,
        startedAt: validRecord.startedAt,
      },
    })
  })

  it('asks the socket only when the start time contradicts the record', async () => {
    const daemon = await answeringDaemonSocket(validRecord.pid, validRecord.token)
    await runDaemonStatus({
      dataDir: '/fake',
      parseRecord: async () => ({
        kind: 'valid',
        record: { ...validRecord, socketPath: daemon.socketPath },
      }),
      isPidAlive: () => true,
      processStartMs: () => Date.parse(validRecord.startedAt) - 1_000,
    })
    expect(daemon.asked).toEqual([])
  })
})

describe('runDaemonStatus: a record this build cannot interpret', () => {
  let dataDir: string
  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'daemon-status-record-'))
  })
  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true })
  })

  async function statusOver(isPidAlive: boolean) {
    await writeFile(
      join(dataDir, 'daemon.json'),
      JSON.stringify({ ...validRecord, version: '9.9.9', launch: 'packaged' }),
    )
    return runDaemonStatus({ dataDir, isPidAlive: () => isPidAlive, processStartMs: () => null })
  }

  it('reports a daemon of another version running, not a malformed record', async () => {
    const { result, exitCode } = await statusOver(true)
    expect(exitCode).toBe(1)
    expect(result).toEqual({
      schemaVersion: 1,
      ok: false,
      reason: 'record-other-version',
      recordFound: true,
      recordFresh: false,
      pidAlive: true,
      record: { pid: validRecord.pid, version: '9.9.9', startedAt: validRecord.startedAt },
    })
  })

  it('reports it malformed once the daemon it names is gone', async () => {
    const { result } = await statusOver(false)
    expect(result.reason).toBe('record-malformed')
  })
})

// A data dir others can write fails the ownership check before daemon.json is
// opened, so nothing about the record is known except whether it is there.
describe.skipIf(!CHMOD_IS_OBSERVABLE)('runDaemonStatus: a data dir it refuses to read', () => {
  let dataDir: string
  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'daemon-status-unreadable-'))
  })
  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true })
  })

  async function statusOver(withRecord: boolean) {
    if (withRecord) {
      await writeFile(
        join(dataDir, 'daemon.json'),
        JSON.stringify({ ...validRecord, pid: process.pid }),
      )
    }
    await chmod(dataDir, 0o777)
    return runDaemonStatus({ dataDir })
  }

  it('reports the record unreadable, not malformed, when a live daemon wrote it', async () => {
    const { result, exitCode } = await statusOver(true)
    expect(exitCode).toBe(1)
    expect(result).toEqual({
      schemaVersion: 1,
      ok: false,
      reason: 'record-unreadable',
      recordFound: true,
      recordFresh: false,
    })
  })

  it('reports no record found where there is none', async () => {
    const { result } = await statusOver(false)
    expect(result).toMatchObject({ reason: 'record-unreadable', recordFound: false })
  })
})

describe('runDaemonStatus: a token-less record whose pid a later process took', () => {
  it('says the pid is not the daemon, as stop and run read it', async () => {
    const { result } = await runDaemonStatus({
      dataDir: '/fake',
      parseRecord: async () => ({
        kind: 'token-missing',
        record: { pid: 42, version: '0.1.0', startedAt: validRecord.startedAt, socketPath: '/x' },
        liveness: { state: 'pid-reused' },
      }),
    })
    expect(result).toMatchObject({ reason: 'record-token-missing', pidAlive: false })
  })
})

describe('runDaemonStatus: a socket answering with a pid no process can have', () => {
  it('reports the identity unconfirmed, naming no serving pid, rather than throwing', async () => {
    const daemon = await answeringDaemonSocket(0, validRecord.token)
    const { result } = await runDaemonStatus({
      dataDir: '/fake',
      parseRecord: async () => ({
        kind: 'valid',
        record: { ...validRecord, socketPath: daemon.socketPath },
      }),
      isPidAlive: () => true,
      processStartMs: () => Date.parse(validRecord.startedAt) + 6_000,
    })
    expect(result).toMatchObject({ reason: 'identity-unconfirmed' })
    expect(result).not.toHaveProperty('servingPid')
  })
})
