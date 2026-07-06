import { describe, expect, it, vi } from 'vitest'
import type { ServerModeRecord } from '../server/security/server-mode-record.js'

// Mock the record reader so tests don't need real files.
vi.mock('../server/security/server-mode-record.js', () => ({
  readServerModeRecord: vi.fn(),
}))

import { readServerModeRecord } from '../server/security/server-mode-record.js'
import { SERVER_STATUS_SCHEMA_VERSION, runServerStatus } from './server-status.js'

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

const alivePid = vi.fn(() => true)
const deadPid = vi.fn(() => false)
const identityOk = async () => true
const identityFail = async () => false

describe('runServerStatus', () => {
  it('missing record → ok:false, state:missing, exit 1', async () => {
    mockRead.mockReturnValueOnce({ kind: 'missing' })
    const { result, exitCode } = await runServerStatus({
      dataDir: '/tmp/test',
      isPidAlive: deadPid,
    })
    expect(exitCode).toBe(1)
    expect(result.ok).toBe(false)
    expect(result.state).toBe('missing')
    expect(result.recordFresh).toBe(false)
    expect(result.schemaVersion).toBe(SERVER_STATUS_SCHEMA_VERSION)
  })

  it('malformed record → ok:false, state:malformed, exit 1', async () => {
    mockRead.mockReturnValueOnce({ kind: 'malformed' })
    const { result, exitCode } = await runServerStatus({
      dataDir: '/tmp/test',
      isPidAlive: deadPid,
    })
    expect(exitCode).toBe(1)
    expect(result.ok).toBe(false)
    expect(result.state).toBe('malformed')
    expect(result.recordFresh).toBe(false)
  })

  it('valid record with dead pid → ok:false, state:stale, exit 1', async () => {
    mockRead.mockReturnValueOnce({ kind: 'ok', record: VALID_RECORD })
    const { result, exitCode } = await runServerStatus({
      dataDir: '/tmp/test',
      isPidAlive: deadPid,
    })
    expect(exitCode).toBe(1)
    expect(result.ok).toBe(false)
    expect(result.state).toBe('stale')
    expect(result.recordFresh).toBe(false)
  })

  it('alive pid but identity mismatch → ok:false, state:stale, exit 1', async () => {
    mockRead.mockReturnValueOnce({ kind: 'ok', record: VALID_RECORD })
    const { result, exitCode } = await runServerStatus({
      dataDir: '/tmp/test',
      isPidAlive: alivePid,
      verifyIdentity: identityFail,
    })
    expect(exitCode).toBe(1)
    expect(result.ok).toBe(false)
    expect(result.state).toBe('stale')
    expect(result.recordFresh).toBe(false)
  })

  it('legacy record without instanceId + alive pid → ok:false, state:unverifiable, exit 1', async () => {
    const legacyRecord: ServerModeRecord = { ...VALID_RECORD, instanceId: undefined }
    mockRead.mockReturnValueOnce({ kind: 'ok', record: legacyRecord })
    // No verifyIdentity override: exercises the default, which must refuse
    // to confirm identity when instanceId is absent.
    const { result, exitCode } = await runServerStatus({
      dataDir: '/tmp/test',
      isPidAlive: alivePid,
    })
    expect(exitCode).toBe(1)
    expect(result.ok).toBe(false)
    expect(result.state).toBe('unverifiable')
    expect(result.recordFresh).toBe(false)
  })

  it('valid record with alive pid + identity ok → ok:true, state:running, exit 0', async () => {
    mockRead.mockReturnValueOnce({ kind: 'ok', record: VALID_RECORD })
    const { result, exitCode } = await runServerStatus({
      dataDir: '/tmp/test',
      isPidAlive: alivePid,
      verifyIdentity: identityOk,
    })
    expect(exitCode).toBe(0)
    expect(result.ok).toBe(true)
    expect(result.state).toBe('running')
    expect(result.recordFresh).toBe(true)
    expect(result.schemaVersion).toBe(SERVER_STATUS_SCHEMA_VERSION)
  })

  it('running result contains all required fields from record', async () => {
    mockRead.mockReturnValueOnce({ kind: 'ok', record: VALID_RECORD })
    const { result } = await runServerStatus({
      dataDir: '/tmp/test',
      isPidAlive: alivePid,
      verifyIdentity: identityOk,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.pid).toBe(VALID_RECORD.pid)
    expect(result.host).toBe(VALID_RECORD.host)
    expect(result.port).toBe(VALID_RECORD.port)
    expect(result.publicBaseUrl).toBe(VALID_RECORD.publicBaseUrl)
    expect(result.authStrategy).toBe(VALID_RECORD.authStrategy)
    expect(result.startedAt).toBe(VALID_RECORD.startedAt)
  })

  it('result is allow-list: no JWKS URI, token, or dataDir fields', async () => {
    mockRead.mockReturnValueOnce({ kind: 'ok', record: VALID_RECORD })
    const { result } = await runServerStatus({
      dataDir: '/tmp/test',
      isPidAlive: alivePid,
      verifyIdentity: identityOk,
    })
    const keys = Object.keys(result)
    expect(keys).not.toContain('jwksUri')
    expect(keys).not.toContain('token')
    expect(keys).not.toContain('dataDir')
    expect(keys).not.toContain('jwtIssuer')
  })

  it('non-leak: malformed result does not echo dataDir or record content', async () => {
    mockRead.mockReturnValueOnce({ kind: 'malformed' })
    const { result } = await runServerStatus({
      dataDir: '/secret/path/whiteboard',
      isPidAlive: deadPid,
    })
    const asText = JSON.stringify(result)
    expect(asText).not.toContain('/secret/path')
    expect(asText).not.toContain('whiteboard')
  })
})
