import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { daemonDoctorResultSchema } from '../shared/api-contracts/daemon-doctor.js'
import { defaultFetchPing, runServerDoctor, SERVER_DOCTOR_CHECK_IDS } from './server-doctor.js'

let dataDir: string
let statusServer: Server | undefined

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'whiteboard-server-doctor-test-'))
})
afterEach(async () => {
  const open = statusServer
  statusServer = undefined
  if (open) await new Promise<void>((resolve) => open.close(() => resolve()))
  await rm(dataDir, { recursive: true, force: true })
})

// Minimal valid flags for a server-doctor run.
// The JWKS URI uses https: so config parse passes.
const VALID_FLAGS = {
  kind: 'ok' as const,
  json: true as const,
  dryRun: false,
  externalUrl: 'https://whiteboard.example.com',
  allowedOrigins: 'https://whiteboard.example.com',
  authStrategy: 'oauth-jwt',
  jwtIssuer: 'https://auth.example.com',
  jwtAudience: 'whiteboard',
  jwksUri: 'https://auth.example.com/.well-known/jwks.json',
  jwtClockSkew: undefined,
  jwtScopeClaim: undefined,
  host: undefined,
  port: undefined,
}

function checkById<T extends { id: string }>(checks: readonly T[], id: string): T {
  const found = checks.find((c) => c.id === id)
  if (!found)
    throw new Error(`expected check ${id}, got: ${JSON.stringify(checks.map((c) => c.id))}`)
  return found
}

/**
 * A valid config, an empty injected env, a JWKS with keys and a writable
 * data dir: each case overrides only the input it is about. A case that
 * means to exercise a REAL default seam calls `runServerDoctor` directly.
 */
function doctor(overrides: Partial<Parameters<typeof runServerDoctor>[0]> = {}) {
  return runServerDoctor({
    flags: { ...VALID_FLAGS, dataDir },
    env: {},
    fetchJwks: async () => ({ ok: true, hasKeys: true }),
    checkDataDir: () => 'ok',
    ...overrides,
  })
}

// Valid record shape for writeServerRecord helper
function makeRecord(overrides: Record<string, unknown> = {}): unknown {
  return {
    schemaVersion: 1,
    pid: process.pid,
    host: '127.0.0.1',
    port: 3099,
    publicBaseUrl: 'https://whiteboard.example.com',
    authStrategy: 'oauth-jwt',
    startedAt: '2026-05-19T00:00:00.000Z',
    ...overrides,
  }
}

async function writeServerRecord(record: unknown) {
  await writeFile(join(dataDir, 'server-mode.json'), JSON.stringify(record), { mode: 0o600 })
}

// ─── 1. Valid config + all checks ok ─────────────────────────────────────────

describe('runServerDoctor', () => {
  it('valid config + all injectable seams ok → overall ok:true, status:ok', async () => {
    await writeServerRecord(makeRecord())
    const { result, exitCode } = await doctor({
      isPidAlive: () => true,
      verifyIdentity: async () => true,
      readRecordMode: () => 0o600,
      fetchPing: async () => ({ ok: true, pidMatches: true }),
      fetchRuntimeStatus: async () => ({ ok: true, protected: false, leakDetected: false }),
    })
    expect(exitCode).toBe(0)
    expect(result.ok).toBe(true)
    expect(result.status).toBe('ok')
    for (const id of [
      'server.config',
      'server.exposure',
      'server.jwks',
      'server.data_dir',
      'server.record',
      'server.record_permissions',
      'server.identity',
      'server.runtime_ping',
      'server.runtime_status',
    ]) {
      expect(checkById(result.checks, id).status, `${id} should be ok`).toBe('ok')
    }
    // Result conforms to the shared Zod schema.
    expect(daemonDoctorResultSchema.parse(result)).toEqual(result)
  })

  it('missing required config field → server.config error, ok:false, no raw values in output', async () => {
    const flags = { ...VALID_FLAGS, dataDir, externalUrl: undefined }
    const { result, exitCode, stdout } = await runServerDoctorWithCapture({
      flags,
      env: {},
      fetchJwks: async () => ({ ok: true, hasKeys: true }),
      checkDataDir: () => 'ok',
    })
    expect(exitCode).toBe(1)
    expect(result.ok).toBe(false)
    expect(checkById(result.checks, 'server.config').status).toBe('error')
    // All subsequent checks skipped
    for (const id of [
      'server.exposure',
      'server.jwks',
      'server.data_dir',
      'server.record',
      'server.record_permissions',
      'server.identity',
      'server.runtime_ping',
      'server.runtime_status',
    ]) {
      expect(checkById(result.checks, id).status, `${id} should be skipped`).toBe('skipped')
    }
    // No raw values in result JSON
    expect(stdout).not.toContain('WHITEBOARD_SERVER_EXTERNAL_URL')
    expect(stdout).not.toContain('https://')
  })

  it('non-HTTPS JWKS URI → server.config error (caught at config parse)', async () => {
    const { result, exitCode } = await doctor({
      flags: { ...VALID_FLAGS, dataDir, jwksUri: 'http://auth.example.com/.well-known/jwks.json' },
    })
    expect(exitCode).toBe(1)
    expect(checkById(result.checks, 'server.config').status).toBe('error')
    expect(checkById(result.checks, 'server.jwks').status).toBe('skipped')
  })

  it('credentialed JWKS URI → server.config error (caught at config parse)', async () => {
    const { result, exitCode } = await runServerDoctor({
      flags: {
        ...VALID_FLAGS,
        dataDir,
        jwksUri: 'https://user:pass@auth.example.com/.well-known/jwks.json',
      },
      env: {},
      checkDataDir: () => 'ok',
    })
    expect(exitCode).toBe(1)
    expect(checkById(result.checks, 'server.config').status).toBe('error')
  })

  it('wildcard allowedOrigins → server.config error (wildcard rejected at config parse)', async () => {
    const { result, exitCode } = await doctor({
      flags: { ...VALID_FLAGS, dataDir, allowedOrigins: '*' },
    })
    expect(exitCode).toBe(1)
    // Wildcard is rejected by parseServerModeEnvConfig
    expect(checkById(result.checks, 'server.config').status).toBe('error')
  })

  it('JWKS fetch failure → server.jwks error', async () => {
    const { result, exitCode } = await doctor({
      fetchJwks: async () => ({ ok: false, hasKeys: false }),
    })
    expect(exitCode).toBe(1)
    expect(checkById(result.checks, 'server.config').status).toBe('ok')
    expect(checkById(result.checks, 'server.jwks').status).toBe('error')
  })

  it('JWKS fetch ok → server.jwks ok', async () => {
    const { result } = await doctor()
    expect(checkById(result.checks, 'server.jwks').status).toBe('ok')
  })

  it('missing data dir → server.data_dir error', async () => {
    const { result, exitCode } = await doctor({
      checkDataDir: () => 'not-exists',
    })
    expect(exitCode).toBe(1)
    expect(checkById(result.checks, 'server.data_dir').status).toBe('error')
  })

  it('non-writable data dir → server.data_dir error', async () => {
    const { result, exitCode } = await doctor({
      checkDataDir: () => 'not-writable',
    })
    expect(exitCode).toBe(1)
    expect(checkById(result.checks, 'server.data_dir').status).toBe('error')
  })

  it('missing record → server.record skipped, and dependent checks skipped', async () => {
    // No record file written — dataDir exists but record is absent
    const { result } = await doctor()
    expect(checkById(result.checks, 'server.record').status).toBe('skipped')
    expect(checkById(result.checks, 'server.record_permissions').status).toBe('skipped')
    expect(checkById(result.checks, 'server.identity').status).toBe('skipped')
    expect(checkById(result.checks, 'server.runtime_ping').status).toBe('skipped')
    expect(checkById(result.checks, 'server.runtime_status').status).toBe('skipped')
  })

  it('malformed record → server.record warning', async () => {
    await writeFile(join(dataDir, 'server-mode.json'), '{ not: valid json', { mode: 0o600 })
    const { result } = await doctor()
    expect(checkById(result.checks, 'server.record').status).toBe('warning')
  })

  // Windows never reads POSIX mode bits, so the check is skipped there by design.
  it.skipIf(process.platform === 'win32')(
    'broad record permissions → server.record_permissions warning (POSIX)',
    async () => {
      await writeServerRecord(makeRecord())
      const { result } = await doctor({
        isPidAlive: () => false, // keep identity skipped to isolate permissions check
        readRecordMode: () => 0o644,
      })
      expect(checkById(result.checks, 'server.record_permissions').status).toBe('warning')
    },
  )

  it('broad record permissions with win32 platform → skipped via readRecordMode returning null', async () => {
    // Simulate Windows by having readRecordMode return null (record unreadable)
    // The actual Windows branch requires process.platform override, but we verify
    // the null path is also handled gracefully.
    await writeServerRecord(makeRecord())
    const { result } = await doctor({
      isPidAlive: () => false,
      readRecordMode: () => null,
    })
    expect(checkById(result.checks, 'server.record_permissions').status).toBe('skipped')
  })

  it('pid alive but identity mismatch → server.identity warning, no kill', async () => {
    await writeServerRecord(makeRecord())
    const { result, exitCode } = await doctor({
      isPidAlive: () => true,
      verifyIdentity: async () => false,
      readRecordMode: () => 0o600,
    })
    expect(checkById(result.checks, 'server.identity').status).toBe('warning')
    // ok is still true because identity mismatch is a warning, not an error
    expect(result.ok).toBe(true)
    expect(exitCode).toBe(0)
    // Downstream checks are skipped because identity is not ok
    expect(checkById(result.checks, 'server.runtime_ping').status).toBe('skipped')
    expect(checkById(result.checks, 'server.runtime_status').status).toBe('skipped')
  })

  // Exercises the real verifyDaemonIdentity (no override injected), same
  // pattern as the "legacy record" tests in server-status.test.ts /
  // server-stop.test.ts, since this is the one branch of the real default
  // that never requires a live network call.

  it('legacy record without instanceId → server.identity warning via the real default verifyIdentity', async () => {
    await writeServerRecord(makeRecord({ instanceId: undefined }))
    const { result } = await doctor({
      isPidAlive: () => true,
      // No verifyIdentity override — exercises the real default, which must
      // refuse to confirm identity when instanceId is absent.
      readRecordMode: () => 0o600,
    })
    expect(checkById(result.checks, 'server.identity').status).toBe('warning')
    expect(checkById(result.checks, 'server.runtime_ping').status).toBe('skipped')
  })

  it('pid dead → server.identity skipped (not error — server just not running)', async () => {
    await writeServerRecord(makeRecord())
    const { result } = await doctor({
      isPidAlive: () => false,
      readRecordMode: () => 0o600,
    })
    expect(checkById(result.checks, 'server.identity').status).toBe('skipped')
    expect(checkById(result.checks, 'server.runtime_ping').status).toBe('skipped')
    expect(checkById(result.checks, 'server.runtime_status').status).toBe('skipped')
  })

  it('runtime ping ok with pid match → server.runtime_ping ok', async () => {
    await writeServerRecord(makeRecord())
    const { result } = await doctor({
      isPidAlive: () => true,
      verifyIdentity: async () => true,
      readRecordMode: () => 0o600,
      fetchPing: async () => ({ ok: true, pidMatches: true }),
      fetchRuntimeStatus: async () => ({ ok: true, protected: false, leakDetected: false }),
    })
    expect(checkById(result.checks, 'server.runtime_ping').status).toBe('ok')
  })

  it('runtime ping with pid mismatch → server.runtime_ping warning', async () => {
    await writeServerRecord(makeRecord())
    const { result } = await doctor({
      isPidAlive: () => true,
      verifyIdentity: async () => true,
      readRecordMode: () => 0o600,
      fetchPing: async () => ({ ok: true, pidMatches: false }),
      fetchRuntimeStatus: async () => ({ ok: true, protected: false, leakDetected: false }),
    })
    expect(checkById(result.checks, 'server.runtime_ping').status).toBe('warning')
  })

  it('runtime status with leak detected → server.runtime_status warning', async () => {
    await writeServerRecord(makeRecord())
    const { result, exitCode } = await doctor({
      isPidAlive: () => true,
      verifyIdentity: async () => true,
      readRecordMode: () => 0o600,
      fetchPing: async () => ({ ok: true, pidMatches: true }),
      fetchRuntimeStatus: async () => ({ ok: true, protected: false, leakDetected: true }),
    })
    expect(checkById(result.checks, 'server.runtime_status').status).toBe('warning')
    // warning keeps ok:true
    expect(result.ok).toBe(true)
    expect(exitCode).toBe(0)
  })

  it('runtime status endpoint returns 401/403 → server.runtime_status ok (properly protected)', async () => {
    // Regression: a correctly configured server-mode deployment protects
    // /api/runtime/status with OAuth. The unauthenticated doctor probe
    // must not report this as an error — the 401/403 IS the expected behavior.
    await writeServerRecord(makeRecord())
    const { result, exitCode } = await doctor({
      isPidAlive: () => true,
      verifyIdentity: async () => true,
      readRecordMode: () => 0o600,
      fetchPing: async () => ({ ok: true, pidMatches: true }),
      fetchRuntimeStatus: async () => ({ ok: true, protected: true, leakDetected: false }),
    })
    expect(checkById(result.checks, 'server.runtime_status').status).toBe('ok')
    expect(result.ok).toBe(true)
    expect(exitCode).toBe(0)
  })

  it('result JSON never contains sensitive tokens, credentials, paths, or JWT prefixes', async () => {
    const SECRET = 'secret-token-XYZ-9999'
    const JWKS_URI = 'https://jwks.example.com/.well-known/jwks.json'
    const DATA_DIR_PATH = dataDir

    await writeServerRecord(makeRecord())
    const { result } = await runServerDoctor({
      flags: {
        ...VALID_FLAGS,
        dataDir,
        jwksUri: JWKS_URI,
      },
      env: {},
      isPidAlive: () => true,
      verifyIdentity: async () => true,
      fetchJwks: async () => ({ ok: true, hasKeys: true }),
      checkDataDir: () => 'ok',
      readRecordMode: () => 0o600,
      fetchPing: async () => ({ ok: true, pidMatches: true }),
      fetchRuntimeStatus: async () => ({ ok: true, protected: false, leakDetected: false }),
    })
    const serialized = JSON.stringify(result)
    expect(serialized).not.toContain(SECRET)
    expect(serialized).not.toContain('Authorization')
    expect(serialized).not.toContain('Bearer')
    expect(serialized).not.toContain('eyJ') // JWT prefix
    // The data dir path itself is not leaked in result check text
    expect(serialized).not.toContain(DATA_DIR_PATH.replace(/\\/g, '/'))
    // No stack frames
    expect(serialized).not.toMatch(/\.ts:\d+/)
  })

  it('any error check → ok:false, exit 1', async () => {
    const { result, exitCode } = await doctor({
      fetchJwks: async () => ({ ok: false, hasKeys: false }), // causes server.jwks error
    })
    expect(result.ok).toBe(false)
    expect(exitCode).toBe(1)
    expect(result.status).toBe('error')
  })

  it('warning only (no error) → ok:true, status:warning, exit 0', async () => {
    await writeServerRecord(makeRecord())
    const { result, exitCode } = await doctor({
      isPidAlive: () => true,
      verifyIdentity: async () => false, // warning: identity mismatch
      readRecordMode: () => 0o600,
    })
    expect(result.ok).toBe(true)
    expect(exitCode).toBe(0)
    expect(result.status).toBe('warning')
  })
})

// ─── Direct unit tests for the default ping implementation ──────────────────
// The seam runServerDoctor falls back to when no fetchPing override is
// injected. Every scenario above injects one.

describe('defaultFetchPing', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('reports pidMatches:true when the ping instanceId equals expectedInstanceId', async () => {
    vi.stubGlobal('fetch', async () => ({
      ok: true,
      json: async () => ({ ok: true, instanceId: 'instance-a' }),
    }))
    await expect(defaultFetchPing('127.0.0.1', 3099, 'instance-a')).resolves.toEqual({
      ok: true,
      pidMatches: true,
    })
  })

  it('never reports pidMatches:true when expectedInstanceId is undefined (legacy record)', async () => {
    // Regression guard: a record without instanceId must never be treated as
    // a match, even if the live daemon's ping response carries a real one.
    vi.stubGlobal('fetch', async () => ({
      ok: true,
      json: async () => ({ ok: true, instanceId: 'instance-a' }),
    }))
    await expect(defaultFetchPing('127.0.0.1', 3099, undefined)).resolves.toEqual({
      ok: true,
      pidMatches: false,
    })
  })
})

// ─── Helper: run with captured stdout ─────────────────────────────────────────

async function runServerDoctorWithCapture(
  options: Parameters<typeof runServerDoctor>[0],
): Promise<{ result: DaemonDoctorResultLike; exitCode: number; stdout: string; stderr: string }> {
  const { result, exitCode } = await runServerDoctor(options)
  return {
    result,
    exitCode,
    stdout: JSON.stringify(result),
    stderr: '',
  }
}

type DaemonDoctorResultLike = Awaited<ReturnType<typeof runServerDoctor>>['result']

/**
 * Every declared check REPORTS, whatever happened.
 *
 * The invalid-config path answers the eight downstream checks as `skipped`,
 * and it used to do that from a list of ids written out by hand beside the
 * nine checks below it — two lists that had to agree, with nothing making
 * them. A tenth check added to the sequence and not to that list would
 * simply be absent from the result on an invalid config: no error, one
 * fewer row, and `ok`/`status` aggregated over whatever did report.
 *
 * `SERVER_DOCTOR_CHECK_IDS` is the one declaration now, and this asserts
 * the result covers it on BOTH paths — the gate is exactly where a missing
 * row is invisible, and the happy path is what proves the declaration is
 * not merely a list nobody runs.
 */
describe('the doctor reports every check it declares', () => {
  it('on an invalid config, where every downstream check is skipped', async () => {
    const { result } = await runServerDoctor({
      // No JWKS URI: config parse fails, so the gate fires.
      flags: { ...VALID_FLAGS, dataDir, jwksUri: undefined },
      env: {},
    })

    expect(result.checks.map((c) => c.id)).toEqual([...SERVER_DOCTOR_CHECK_IDS])
    expect(checkById(result.checks, 'server.config').status).toBe('error')
    for (const id of SERVER_DOCTOR_CHECK_IDS.filter((each) => each !== 'server.config')) {
      expect(checkById(result.checks, id).status).toBe('skipped')
    }
  })

  it('on a valid config, where each one really runs', async () => {
    await writeServerRecord(makeRecord())
    const { result } = await doctor({
      isPidAlive: () => true,
      verifyIdentity: async () => true,
      readRecordMode: () => 0o600,
      fetchPing: async () => ({ ok: true, pidMatches: true }),
      fetchRuntimeStatus: async () => ({ ok: true, protected: true, leakDetected: false }),
    })

    expect(result.checks.map((c) => c.id)).toEqual([...SERVER_DOCTOR_CHECK_IDS])
    expect(result.checks.every((c) => c.status !== 'skipped')).toBe(true)
  })
})

/**
 * The Windows branch of the permissions check, which the tests beside it
 * say outright they cannot reach ("we can't override process.platform").
 * It IS reachable — `process.platform` is a configurable property — and the
 * branch has two halves worth pinning, because the second is invisible in
 * the result: Windows reports `skipped`, AND never reads the mode bits at
 * all. POSIX mode bits do not describe a Windows ACL, so reading them is
 * not merely useless, it is a filesystem call made to ask a meaningless
 * question.
 */
describe('the record-permissions check on Windows', () => {
  const realPlatform = process.platform
  const asPlatform = (value: NodeJS.Platform) => {
    Object.defineProperty(process, 'platform', { value, configurable: true })
  }
  afterEach(() => asPlatform(realPlatform))

  it('skips, and does not read POSIX mode bits to get there', async () => {
    await writeServerRecord(makeRecord())
    asPlatform('win32')
    const readRecordMode = vi.fn(() => 0o644)

    const { result } = await doctor({
      isPidAlive: () => false,
      readRecordMode,
    })

    const check = checkById(result.checks, 'server.record_permissions')
    expect(check.status).toBe('skipped')
    expect(check.summary).toContain('Windows')
    expect(readRecordMode).not.toHaveBeenCalled()
  })

  it('reads them on a POSIX platform, and reports what they say', async () => {
    await writeServerRecord(makeRecord())
    asPlatform('linux')
    const readRecordMode = vi.fn(() => 0o644)

    const { result } = await doctor({
      isPidAlive: () => false,
      readRecordMode,
    })

    expect(checkById(result.checks, 'server.record_permissions').status).toBe('warning')
    expect(readRecordMode).toHaveBeenCalledTimes(1)
  })
})

// ─── Default seams: real filesystem and real HTTP ───────────────────────────
// Every case above injects checkDataDir / fetchRuntimeStatus; these leave them
// at their defaults so the mapping from a real errno or status code to a
// check is what is under test.

describe('server doctor default seams', () => {
  const base = { env: {}, fetchJwks: async () => ({ ok: true, hasKeys: true }) }

  async function serveStatus(status: number, body: string): Promise<number> {
    const srv = createServer((_req, res) => {
      res.statusCode = status
      res.end(body)
    })
    statusServer = srv
    await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve))
    return (srv.address() as AddressInfo).port
  }

  async function runtimeStatusCheckAgainst(status: number, body: string) {
    const port = await serveStatus(status, body)
    await writeServerRecord(makeRecord({ port }))
    const { result } = await runServerDoctor({
      ...base,
      flags: { ...VALID_FLAGS, dataDir },
      isPidAlive: () => true,
      verifyIdentity: async () => true,
      fetchPing: async () => ({ ok: true, pidMatches: true }),
      readRecordMode: () => 0o600,
      checkDataDir: () => 'ok',
    })
    return checkById(result.checks, 'server.runtime_status')
  }

  it('a data dir that does not exist is "does not exist", not "not writable"', async () => {
    const { result } = await runServerDoctor({
      ...base,
      flags: { ...VALID_FLAGS, dataDir: join(dataDir, 'absent') },
    })
    const c = checkById(result.checks, 'server.data_dir')
    expect(c.status).toBe('error')
    expect(c.summary).toBe('Data directory does not exist')
  })

  it('a writable data dir is ok', async () => {
    const { result } = await runServerDoctor({ ...base, flags: { ...VALID_FLAGS, dataDir } })
    expect(checkById(result.checks, 'server.data_dir').status).toBe('ok')
  })

  it('a record that exists but cannot be read is a warning, never "found and valid"', async () => {
    await mkdir(join(dataDir, 'server-mode.json'))
    const { result } = await runServerDoctor({
      ...base,
      flags: { ...VALID_FLAGS, dataDir },
      checkDataDir: () => 'ok',
    })
    const c = checkById(result.checks, 'server.record')
    expect(c.status).toBe('warning')
    expect(c.summary).toBe('Server record exists but cannot be read')
  })

  it('a missing record does not read a mode: permissions are skipped for that reason', async () => {
    const { result } = await runServerDoctor({
      ...base,
      flags: { ...VALID_FLAGS, dataDir },
      checkDataDir: () => 'ok',
      readRecordMode: () => {
        throw new Error('must not be read without a record')
      },
    })
    expect(checkById(result.checks, 'server.record_permissions').summary).toBe(
      'Skipped because the server record is missing or malformed',
    )
  })

  it.each([401, 403])('a %i from /api/runtime/status is reported as protected', async (status) => {
    const c = await runtimeStatusCheckAgainst(status, 'nope')
    expect(c.status).toBe('ok')
    expect(c.summary).toBe('Runtime status endpoint is properly protected')
  })

  it('an unprotected status body naming a secret field is a warning', async () => {
    const c = await runtimeStatusCheckAgainst(200, JSON.stringify({ jwksUri: 'https://x' }))
    expect(c.status).toBe('warning')
  })

  it('an unprotected, clean status body is ok with the no-leak summary', async () => {
    const c = await runtimeStatusCheckAgainst(200, JSON.stringify({ ok: true }))
    expect(c.status).toBe('ok')
    expect(c.summary).toBe('Runtime status endpoint responded without detected leaks')
  })

  it('a 500 from /api/runtime/status is an error', async () => {
    const c = await runtimeStatusCheckAgainst(500, 'boom')
    expect(c.status).toBe('error')
  })
})

// ─── Paths every case above shares, so no case above can tell apart ─────────
// Each case above passes a `dataDir` flag, an empty injected env, and a JWKS
// seam answering either "unreachable" or "has keys". These pin the inputs
// that choice hides: which env is read, which data dir is checked, the
// reachable-but-empty JWKS, an exposure the config parser lets through, and
// the real JWKS / data-dir / ping seams.

describe('server doctor inputs the cases above hold fixed', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  })

  const quietSeams = {
    isPidAlive: () => false,
    readRecordMode: () => 0o600,
  }

  it('a reachable JWKS endpoint with no keys is an error, not ok', async () => {
    const { result, exitCode } = await runServerDoctor({
      ...quietSeams,
      flags: { ...VALID_FLAGS, dataDir },
      env: {},
      fetchJwks: async () => ({ ok: true, hasKeys: false }),
      checkDataDir: () => 'ok',
    })
    const c = checkById(result.checks, 'server.jwks')
    expect(c.status).toBe('error')
    expect(c.summary).toBe('JWKS endpoint returned no keys')
    expect(exitCode).toBe(1)
  })

  it('a plain-http external URL passes config parse and fails the exposure check', async () => {
    const { result } = await runServerDoctor({
      ...quietSeams,
      flags: { ...VALID_FLAGS, dataDir, externalUrl: 'http://whiteboard.example.com' },
      env: {},
      fetchJwks: async () => ({ ok: true, hasKeys: true }),
      checkDataDir: () => 'ok',
    })
    expect(checkById(result.checks, 'server.config').status).toBe('ok')
    const c = checkById(result.checks, 'server.exposure')
    expect(c.status).toBe('error')
    expect(c.summary).toBe('Server exposure plan is invalid')
  })

  it('reads the injected env, not the process env', async () => {
    const injectedDir = join(dataDir, 'injected')
    vi.stubEnv('WHITEBOARD_DATA_DIR', join(dataDir, 'from-process-env'))
    const checkDataDir = vi.fn(() => 'ok' as const)
    await runServerDoctor({
      ...quietSeams,
      flags: { ...VALID_FLAGS, dataDir: undefined },
      env: { WHITEBOARD_DATA_DIR: injectedDir },
      fetchJwks: async () => ({ ok: true, hasKeys: true }),
      checkDataDir,
    })
    expect(checkDataDir).toHaveBeenCalledWith(injectedDir)
  })

  it('with no data dir configured, checks the default one', async () => {
    const checkDataDir = vi.fn((_dir: string) => 'ok' as const)
    const { result } = await runServerDoctor({
      ...quietSeams,
      flags: { ...VALID_FLAGS, dataDir: undefined },
      env: {},
      fetchJwks: async () => ({ ok: true, hasKeys: true }),
      checkDataDir,
    })
    expect(checkDataDir).toHaveBeenCalledTimes(1)
    const checked = checkDataDir.mock.calls[0]?.[0]
    expect(typeof checked).toBe('string')
    expect(checked?.endsWith('.whiteboard')).toBe(true)
    expect(checkById(result.checks, 'server.data_dir').status).toBe('ok')
  })

  describe('the default JWKS fetch', () => {
    async function jwksCheckWhenFetchAnswers(answer: () => Promise<unknown>) {
      vi.stubGlobal('fetch', answer)
      const { result } = await runServerDoctor({
        ...quietSeams,
        flags: { ...VALID_FLAGS, dataDir },
        env: {},
        checkDataDir: () => 'ok',
      })
      return checkById(result.checks, 'server.jwks')
    }

    it('a keys array with an entry is reachable and has keys', async () => {
      const c = await jwksCheckWhenFetchAnswers(async () => ({
        ok: true,
        json: async () => ({ keys: [{ kty: 'RSA' }] }),
      }))
      expect(c.status).toBe('ok')
    })

    it('an empty keys array is "no keys"', async () => {
      const c = await jwksCheckWhenFetchAnswers(async () => ({
        ok: true,
        json: async () => ({ keys: [] }),
      }))
      expect(c.summary).toBe('JWKS endpoint returned no keys')
    })

    it('a keys field that is not an array is "no keys"', async () => {
      const c = await jwksCheckWhenFetchAnswers(async () => ({
        ok: true,
        json: async () => ({ keys: { kty: 'RSA' } }),
      }))
      expect(c.summary).toBe('JWKS endpoint returned no keys')
    })

    it('a non-ok response is "not reachable"', async () => {
      const c = await jwksCheckWhenFetchAnswers(async () => ({
        ok: false,
        json: async () => ({ keys: [{ kty: 'RSA' }] }),
      }))
      expect(c.summary).toBe('JWKS endpoint is not reachable')
    })

    it('a fetch that throws is "not reachable"', async () => {
      const c = await jwksCheckWhenFetchAnswers(async () => {
        throw new TypeError('fetch failed')
      })
      expect(c.summary).toBe('JWKS endpoint is not reachable')
    })
  })

  it('the default data-dir check reports a non-ENOENT failure as not writable', async () => {
    // A path running through a regular file fails with ENOTDIR: a failure
    // that is not "missing", and one root cannot bypass the way it bypasses
    // a mode-bit denial.
    const file = join(dataDir, 'a-file')
    await writeFile(file, '')
    const { result } = await runServerDoctor({
      ...quietSeams,
      flags: { ...VALID_FLAGS, dataDir: join(file, 'beneath') },
      env: {},
      fetchJwks: async () => ({ ok: true, hasKeys: true }),
    })
    expect(checkById(result.checks, 'server.data_dir').summary).toBe(
      'Data directory is not writable',
    )
  })

  it('the default ping reports pidMatches:false when the instanceId differs', async () => {
    vi.stubGlobal('fetch', async () => ({
      ok: true,
      json: async () => ({ ok: true, instanceId: 'instance-b' }),
    }))
    await expect(defaultFetchPing('127.0.0.1', 3099, 'instance-a')).resolves.toEqual({
      ok: true,
      pidMatches: false,
    })
  })
})
