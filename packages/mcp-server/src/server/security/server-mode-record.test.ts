import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  type ServerModeRecord,
  SERVER_MODE_RECORD_SCHEMA_VERSION,
  deleteServerModeRecord,
  getServerModeRecordPath,
  readServerModeRecord,
  serverModeRecordSchema,
  writeServerModeRecord,
} from './server-mode-record.js'

const VALID_RECORD: ServerModeRecord = {
  schemaVersion: SERVER_MODE_RECORD_SCHEMA_VERSION,
  pid: 12345,
  host: '0.0.0.0',
  port: 3099,
  publicBaseUrl: 'https://whiteboard.example.com',
  authStrategy: 'oauth-jwt',
  startedAt: '2026-05-19T00:00:00.000Z',
}

// ---------------------------------------------------------------------------
// Schema validation
// ---------------------------------------------------------------------------

describe('serverModeRecordSchema', () => {
  it('accepts a valid record', () => {
    const result = serverModeRecordSchema.safeParse(VALID_RECORD)
    expect(result.success).toBe(true)
  })

  it('accepts startedAt with timezone offset', () => {
    const result = serverModeRecordSchema.safeParse({
      ...VALID_RECORD,
      startedAt: '2026-05-19T09:00:00+09:00',
    })
    expect(result.success).toBe(true)
  })

  it('rejects startedAt without offset (plain ISO)', () => {
    const result = serverModeRecordSchema.safeParse({
      ...VALID_RECORD,
      startedAt: '2026-05-19T00:00:00',
    })
    expect(result.success).toBe(false)
  })

  it('rejects wrong schemaVersion', () => {
    expect(serverModeRecordSchema.safeParse({ ...VALID_RECORD, schemaVersion: 2 }).success).toBe(
      false,
    )
  })

  it('rejects pid = 0', () => {
    expect(serverModeRecordSchema.safeParse({ ...VALID_RECORD, pid: 0 }).success).toBe(false)
  })

  it('rejects port = 0', () => {
    expect(serverModeRecordSchema.safeParse({ ...VALID_RECORD, port: 0 }).success).toBe(false)
  })

  it('rejects port > 65535', () => {
    expect(serverModeRecordSchema.safeParse({ ...VALID_RECORD, port: 65536 }).success).toBe(false)
  })

  it('rejects empty host', () => {
    expect(serverModeRecordSchema.safeParse({ ...VALID_RECORD, host: '' }).success).toBe(false)
  })

  it('rejects unknown authStrategy', () => {
    expect(
      serverModeRecordSchema.safeParse({ ...VALID_RECORD, authStrategy: 'local-token' }).success,
    ).toBe(false)
  })

  it('rejects missing required field', () => {
    const { pid: _pid, ...withoutPid } = VALID_RECORD
    expect(serverModeRecordSchema.safeParse(withoutPid).success).toBe(false)
  })

  it('does not expose JWKS URI or token fields in parsed type', () => {
    const result = serverModeRecordSchema.safeParse({
      ...VALID_RECORD,
      jwksUri: 'https://secret.example.com/jwks',
      token: 'secret-bearer',
    })
    expect(result.success).toBe(true)
    if (!result.success) return
    // Extra fields stripped by Zod v4 default (strip mode)
    expect((result.data as Record<string, unknown>)['jwksUri']).toBeUndefined()
    expect((result.data as Record<string, unknown>)['token']).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// File I/O
// ---------------------------------------------------------------------------

let tmpDir: string

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'wbsm-record-test-'))
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

describe('writeServerModeRecord', () => {
  it('creates parent directory when it does not exist (tmp fallback case)', () => {
    // The tmp fallback path may not exist yet; the writer must create it.
    const nestedDir = join(tmpDir, 'nonexistent-parent', '.whiteboard')
    writeServerModeRecord(nestedDir, VALID_RECORD)
    const result = readServerModeRecord(nestedDir)
    expect(result.kind).toBe('ok')
  })

  it('creates parent directory with 0o700 mode (owner-only data dir)', () => {
    const nestedDir = join(tmpDir, 'mode-test', '.whiteboard')
    writeServerModeRecord(nestedDir, VALID_RECORD)
    const stat = statSync(join(tmpDir, 'mode-test', '.whiteboard'))
    expect(stat.mode & 0o777).toBe(0o700)
  })

  it('tightens broad permissions on pre-existing directory', () => {
    const dir = join(tmpDir, 'broad-dir')
    mkdirSync(dir, { mode: 0o755 })
    expect(statSync(dir).mode & 0o777).toBe(0o755)
    writeServerModeRecord(dir, VALID_RECORD)
    expect(statSync(dir).mode & 0o777).toBe(0o700)
  })

  it('writes valid JSON to the record path', () => {
    writeServerModeRecord(tmpDir, VALID_RECORD)
    const read = readServerModeRecord(tmpDir)
    expect(read.kind).toBe('ok')
    if (read.kind !== 'ok') return
    expect(read.record.pid).toBe(VALID_RECORD.pid)
    expect(read.record.port).toBe(VALID_RECORD.port)
    expect(read.record.publicBaseUrl).toBe(VALID_RECORD.publicBaseUrl)
  })

  it('writes with mode 0o600 (owner-only)', () => {
    writeServerModeRecord(tmpDir, VALID_RECORD)
    const path = getServerModeRecordPath(tmpDir)
    const stat = statSync(path)
    // Mask off file type bits; compare permission bits only
    expect(stat.mode & 0o777).toBe(0o600)
  })

  it('repairs broad permissions on pre-existing file', () => {
    const path = getServerModeRecordPath(tmpDir)
    // Simulate a pre-existing file with broad permissions
    writeFileSync(path, '{}', { mode: 0o644 })
    expect(statSync(path).mode & 0o777).toBe(0o644)
    writeServerModeRecord(tmpDir, VALID_RECORD)
    expect(statSync(path).mode & 0o777).toBe(0o600)
  })

  it('written JSON contains only allow-listed fields', () => {
    writeServerModeRecord(tmpDir, VALID_RECORD)
    const path = getServerModeRecordPath(tmpDir)
    const raw = readFileSync(path, 'utf8')
    const parsed = JSON.parse(raw)
    const keys = Object.keys(parsed)
    expect(keys).toContain('pid')
    expect(keys).toContain('host')
    expect(keys).toContain('port')
    expect(keys).toContain('publicBaseUrl')
    expect(keys).toContain('authStrategy')
    expect(keys).toContain('startedAt')
    // No secret fields
    expect(keys).not.toContain('token')
    expect(keys).not.toContain('jwksUri')
    expect(keys).not.toContain('jwtIssuer')
    expect(keys).not.toContain('dataDir')
  })
})

describe('readServerModeRecord', () => {
  it('returns missing when file does not exist', () => {
    expect(readServerModeRecord(tmpDir).kind).toBe('missing')
  })

  it('returns malformed when file is not JSON', () => {
    writeFileSync(getServerModeRecordPath(tmpDir), 'not json')
    expect(readServerModeRecord(tmpDir).kind).toBe('malformed')
  })

  it('returns malformed when JSON does not match schema', () => {
    writeFileSync(getServerModeRecordPath(tmpDir), JSON.stringify({ pid: 'not-a-number' }))
    expect(readServerModeRecord(tmpDir).kind).toBe('malformed')
  })

  it('returns ok with the parsed record for valid content', () => {
    writeServerModeRecord(tmpDir, VALID_RECORD)
    const result = readServerModeRecord(tmpDir)
    expect(result.kind).toBe('ok')
    if (result.kind !== 'ok') return
    expect(result.record).toEqual(VALID_RECORD)
  })
})

describe('deleteServerModeRecord', () => {
  it('removes the record file', () => {
    writeServerModeRecord(tmpDir, VALID_RECORD)
    deleteServerModeRecord(tmpDir)
    expect(readServerModeRecord(tmpDir).kind).toBe('missing')
  })

  it('does not throw when file does not exist', () => {
    expect(() => deleteServerModeRecord(tmpDir)).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// Non-leak: malformed record must not expose raw file content in result
// ---------------------------------------------------------------------------

describe('readServerModeRecord — non-leak', () => {
  it('malformed JSON does not appear in the result object', () => {
    const sensitive = 'secret-path-/opt/whiteboard-config'
    writeFileSync(getServerModeRecordPath(tmpDir), sensitive)
    const result = readServerModeRecord(tmpDir)
    expect(result.kind).toBe('malformed')
    expect(JSON.stringify(result)).not.toContain(sensitive)
  })

  it('malformed JSON with credential-like key does not propagate the value', () => {
    writeFileSync(
      getServerModeRecordPath(tmpDir),
      JSON.stringify({
        schemaVersion: 1,
        pid: 1,
        jwksUri: 'https://secret.example.com/jwks?token=abc123',
        token: 'Bearer-secret-xyz',
      }),
    )
    const result = readServerModeRecord(tmpDir)
    expect(result.kind).toBe('malformed')
    expect(JSON.stringify(result)).not.toContain('secret')
    expect(JSON.stringify(result)).not.toContain('Bearer')
  })
})
