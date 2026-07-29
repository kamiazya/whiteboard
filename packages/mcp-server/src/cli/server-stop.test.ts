import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ServerModeRecord } from '../server/security/server-mode-record.js'

vi.mock('../server/security/server-mode-record.js', () => ({
  readServerModeRecord: vi.fn(),
  getServerModeRecordPath: vi.fn((d: string) => `${d}/server-mode.json`),
}))

import { readServerModeRecord } from '../server/security/server-mode-record.js'
import { defaultVerifyIdentity, runServerStop, SERVER_STOP_SCHEMA_VERSION } from './server-stop.js'

const mockRead = vi.mocked(readServerModeRecord)

const VALID_RECORD: ServerModeRecord = {
  schemaVersion: 1,
  pid: 42,
  host: '0.0.0.0',
  port: 3099,
  publicBaseUrl: 'https://whiteboard.example.com',
  authStrategy: 'oauth-jwt',
  startedAt: '2026-05-19T00:00:00.000Z',
  instanceId: 'valid-instance-id',
}

const noOp = async () => {}
const alivePid = vi.fn(() => true)
const deadPid = vi.fn(() => false)
const noKill = vi.fn()
const identityOk = async () => true
const identityFail = async () => false

describe('runServerStop', () => {
  it('missing record → ok:true, action:not-running, exit 0', async () => {
    mockRead.mockReturnValueOnce({ kind: 'missing' })
    const { result, exitCode } = await runServerStop({
      dataDir: '/tmp/test',
      isPidAlive: deadPid,
      killFn: noKill,
      removeRecord: noOp,
    })
    expect(exitCode).toBe(0)
    expect(result.ok).toBe(true)
    expect(result.action).toBe('not-running')
    expect(result.reason).toBe('server-record-not-found')
    expect(result.schemaVersion).toBe(SERVER_STOP_SCHEMA_VERSION)
    expect(noKill).not.toHaveBeenCalled()
  })

  it('malformed record → ok:false, action:refused, exit 2', async () => {
    mockRead.mockReturnValueOnce({ kind: 'malformed' })
    const { result, exitCode } = await runServerStop({
      dataDir: '/tmp/test',
      isPidAlive: deadPid,
      killFn: noKill,
      removeRecord: noOp,
    })
    expect(exitCode).toBe(2)
    expect(result.ok).toBe(false)
    expect(result.action).toBe('refused')
    expect(result.reason).toBe('server-record-malformed')
    expect(noKill).not.toHaveBeenCalled()
  })

  it('stale pid → ok:true, action:not-running, exit 0, no signal sent', async () => {
    mockRead.mockReturnValueOnce({ kind: 'ok', record: VALID_RECORD })
    const { result, exitCode } = await runServerStop({
      dataDir: '/tmp/test',
      isPidAlive: deadPid,
      killFn: noKill,
      removeRecord: noOp,
    })
    expect(exitCode).toBe(0)
    expect(result.ok).toBe(true)
    expect(result.action).toBe('not-running')
    expect(result.reason).toBe('server-process-not-running')
    expect(noKill).not.toHaveBeenCalled()
  })

  it('alive pid + identity ok → SIGTERM sent, process exits → ok:true, action:stopped, exit 0', async () => {
    mockRead.mockReturnValueOnce({ kind: 'ok', record: VALID_RECORD })
    const killFn = vi.fn()
    // Process "exits" after SIGTERM: first isPidAlive call (liveness check) returns true,
    // subsequent calls during waitForExit return false.
    const isPidAlive = vi.fn().mockReturnValueOnce(true).mockReturnValue(false)
    const { result, exitCode } = await runServerStop({
      dataDir: '/tmp/test',
      isPidAlive,
      verifyIdentity: identityOk,
      killFn,
      sleep: async () => {},
      removeRecord: noOp,
      stopTimeoutMs: 1000,
    })
    expect(exitCode).toBe(0)
    expect(result.ok).toBe(true)
    expect(result.action).toBe('stopped')
    expect(result.reason).toBeNull()
    expect(result.pid).toBe(VALID_RECORD.pid)
    expect(killFn).toHaveBeenCalledWith(VALID_RECORD.pid, 'SIGTERM')
  })

  it('alive pid but identity mismatch → not-running (PID reuse), no kill', async () => {
    mockRead.mockReturnValueOnce({ kind: 'ok', record: VALID_RECORD })
    const killFn = vi.fn()
    const { result, exitCode } = await runServerStop({
      dataDir: '/tmp/test',
      isPidAlive: alivePid,
      verifyIdentity: identityFail,
      killFn,
      removeRecord: noOp,
    })
    expect(exitCode).toBe(0)
    expect(result.ok).toBe(true)
    expect(result.action).toBe('not-running')
    expect(result.reason).toBe('server-process-not-running')
    expect(killFn).not.toHaveBeenCalled()
  })

  it('legacy record without instanceId → identity unverifiable, not-running, no kill', async () => {
    const legacyRecord: ServerModeRecord = { ...VALID_RECORD, instanceId: undefined }
    mockRead.mockReturnValueOnce({ kind: 'ok', record: legacyRecord })
    const killFn = vi.fn()
    // No verifyIdentity override: exercises the default, which must refuse
    // to confirm identity when instanceId is absent.
    const { result, exitCode } = await runServerStop({
      dataDir: '/tmp/test',
      isPidAlive: alivePid,
      killFn,
      removeRecord: noOp,
    })
    expect(exitCode).toBe(0)
    expect(result.ok).toBe(true)
    expect(result.action).toBe('not-running')
    expect(result.reason).toBe('server-instance-unverifiable')
    expect(killFn).not.toHaveBeenCalled()
  })

  it('SIGTERM timeout → identity still matches → SIGKILL sent, action:stopped with timeout reason', async () => {
    mockRead.mockReturnValueOnce({ kind: 'ok', record: VALID_RECORD })
    const killFn = vi.fn()
    const { result, exitCode } = await runServerStop({
      dataDir: '/tmp/test',
      isPidAlive: alivePid, // never dies
      verifyIdentity: identityOk,
      killFn,
      sleep: async () => {},
      removeRecord: noOp,
      stopTimeoutMs: 1, // immediate timeout
      pollIntervalMs: 1,
    })
    expect(exitCode).toBe(0)
    expect(result.ok).toBe(true)
    expect(result.action).toBe('stopped')
    expect(result.reason).toBe('server-stop-timeout')
    expect(killFn).toHaveBeenCalledWith(VALID_RECORD.pid, 'SIGTERM')
    expect(killFn).toHaveBeenCalledWith(VALID_RECORD.pid, 'SIGKILL')
  })

  it('SIGTERM timeout + PID reused (identity mismatch before SIGKILL) → no SIGKILL', async () => {
    mockRead.mockReturnValueOnce({ kind: 'ok', record: VALID_RECORD })
    const killFn = vi.fn()
    // First identity call (before SIGTERM) passes; subsequent call (before SIGKILL) fails.
    const verifyIdentity = vi.fn().mockResolvedValueOnce(true).mockResolvedValue(false)
    const { result, exitCode } = await runServerStop({
      dataDir: '/tmp/test',
      isPidAlive: alivePid, // PID still in OS (reused by other process)
      verifyIdentity,
      killFn,
      sleep: async () => {},
      removeRecord: noOp,
      stopTimeoutMs: 1,
      pollIntervalMs: 1,
    })
    expect(exitCode).toBe(0)
    expect(result.ok).toBe(true)
    expect(result.action).toBe('stopped')
    expect(result.reason).toBe('server-stop-timeout')
    expect(killFn).toHaveBeenCalledWith(VALID_RECORD.pid, 'SIGTERM')
    expect(killFn).not.toHaveBeenCalledWith(VALID_RECORD.pid, 'SIGKILL')
  })

  it('ESRCH on kill → not-running (race window), no error', async () => {
    mockRead.mockReturnValueOnce({ kind: 'ok', record: VALID_RECORD })
    const killFn = vi.fn().mockImplementationOnce(() => {
      const err = Object.assign(new Error('ESRCH'), { code: 'ESRCH' })
      throw err
    })
    const isPidAlive = vi.fn().mockReturnValueOnce(true) // first check passes
    const { result, exitCode } = await runServerStop({
      dataDir: '/tmp/test',
      isPidAlive,
      verifyIdentity: identityOk,
      killFn,
      removeRecord: noOp,
    })
    expect(exitCode).toBe(0)
    expect(result.action).toBe('not-running')
  })

  it('signal failure (non-ESRCH) → refused, exit 1', async () => {
    mockRead.mockReturnValueOnce({ kind: 'ok', record: VALID_RECORD })
    const killFn = vi.fn().mockImplementationOnce(() => {
      const err = Object.assign(new Error('EPERM'), { code: 'EPERM' })
      throw err
    })
    const isPidAlive = vi.fn().mockReturnValueOnce(true)
    const { result, exitCode } = await runServerStop({
      dataDir: '/tmp/test',
      isPidAlive,
      verifyIdentity: identityOk,
      killFn,
      removeRecord: noOp,
    })
    expect(exitCode).toBe(1)
    expect(result.action).toBe('refused')
    expect(result.reason).toBe('server-stop-signal-failed')
  })

  it('non-leak: result does not contain dataDir path or secret fields', async () => {
    mockRead.mockReturnValueOnce({ kind: 'ok', record: VALID_RECORD })
    const killFn = vi.fn()
    const isPidAlive = vi.fn().mockReturnValueOnce(true).mockReturnValue(false)
    const { result } = await runServerStop({
      dataDir: '/secret/data/path',
      isPidAlive,
      verifyIdentity: identityOk,
      killFn,
      sleep: async () => {},
      removeRecord: noOp,
    })
    const asText = JSON.stringify(result)
    expect(asText).not.toContain('/secret/data/path')
    expect(asText).not.toContain('jwksUri')
    expect(asText).not.toContain('token')
    expect(asText).not.toContain('Bearer')
  })
})

// ─── Direct unit tests for the default identity implementation ──────────────
// Every scenario above injects a verifyIdentity override, so without these
// the real fetchDaemonPing(...) + instanceId comparison — the code path that
// decides whether server-stop is allowed to kill the recorded pid — would go
// uncovered.

describe('defaultVerifyIdentity', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('confirms identity when the ping response instanceId matches the record', async () => {
    vi.stubGlobal('fetch', async () => ({
      ok: true,
      json: async () => ({ ok: true, instanceId: 'valid-instance-id' }),
    }))
    await expect(defaultVerifyIdentity(VALID_RECORD)).resolves.toBe(true)
  })

  it('refuses to confirm identity when the ping response instanceId mismatches', async () => {
    vi.stubGlobal('fetch', async () => ({
      ok: true,
      json: async () => ({ ok: true, instanceId: 'some-other-instance-id' }),
    }))
    await expect(defaultVerifyIdentity(VALID_RECORD)).resolves.toBe(false)
  })

  it('never confirms identity when the record predates instanceId', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const legacyRecord: ServerModeRecord = { ...VALID_RECORD, instanceId: undefined }
    await expect(defaultVerifyIdentity(legacyRecord)).resolves.toBe(false)
    // Short-circuits before making a network call.
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
