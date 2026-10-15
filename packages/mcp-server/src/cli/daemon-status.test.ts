import { describe, expect, it } from 'vitest'
import { answeringDaemonSocket } from '../daemon/_test-daemon-socket.js'
import { runDaemonStatus } from './daemon-status.js'

// All tests inject parseRecord, isPidAlive and processStartMs — no filesystem or process access.

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
      parseRecord: async () => ({ kind: 'token-missing', record: tokenMissingRecord }),
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
      parseRecord: async () => ({ kind: 'token-missing', record: tokenMissingRecord }),
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
