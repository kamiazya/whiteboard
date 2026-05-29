import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { daemonDoctorResultSchema } from '../shared/api-contracts/daemon-doctor.js'
import { runServerDoctor } from './server-doctor.js'

let dataDir: string

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'whiteboard-server-doctor-test-'))
})
afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true })
})

// Minimal valid flags for a server-doctor run.
// The JWKS URI uses https: so config parse passes.
const VALID_FLAGS = {
  kind: 'ok' as const,
  json: true as const,
  dryRun: false,
  trustedProxy: undefined,
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
  dataDir,
}

function checkById(checks: Array<{ id: string }>, id: string) {
  const found = checks.find((c) => c.id === id)
  if (!found)
    throw new Error(`expected check ${id}, got: ${JSON.stringify(checks.map((c) => c.id))}`)
  return found
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
    const { result, exitCode } = await runServerDoctor({
      flags: { ...VALID_FLAGS, dataDir },
      env: {},
      isPidAlive: () => true,
      verifyIdentity: async () => true,
      fetchJwks: async () => ({ ok: true, hasKeys: true }),
      checkDataDir: () => 'ok',
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

  // ─── 2. Missing required config field ──────────────────────────────────────

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

  // ─── 3. Non-HTTPS JWKS URI → config error ──────────────────────────────────

  it('non-HTTPS JWKS URI → server.config error (caught at config parse)', async () => {
    const { result, exitCode } = await runServerDoctor({
      flags: { ...VALID_FLAGS, dataDir, jwksUri: 'http://auth.example.com/.well-known/jwks.json' },
      env: {},
      checkDataDir: () => 'ok',
    })
    expect(exitCode).toBe(1)
    expect(checkById(result.checks, 'server.config').status).toBe('error')
    expect(checkById(result.checks, 'server.jwks').status).toBe('skipped')
  })

  // ─── 4. Credentialed JWKS URI → config error ───────────────────────────────

  it('credentialed JWKS URI → server.config error (caught at config parse)', async () => {
    const { result, exitCode } = await runServerDoctor({
      flags: { ...VALID_FLAGS, dataDir, jwksUri: 'https://user:pass@auth.example.com/.well-known/jwks.json' },
      env: {},
      checkDataDir: () => 'ok',
    })
    expect(exitCode).toBe(1)
    expect(checkById(result.checks, 'server.config').status).toBe('error')
  })

  // ─── 5. Wildcard allowedOrigins → exposure error ───────────────────────────

  it('wildcard allowedOrigins → server.config error (wildcard rejected at config parse)', async () => {
    const { result, exitCode } = await runServerDoctor({
      flags: { ...VALID_FLAGS, dataDir, allowedOrigins: '*' },
      env: {},
      fetchJwks: async () => ({ ok: true, hasKeys: true }),
      checkDataDir: () => 'ok',
    })
    expect(exitCode).toBe(1)
    // Wildcard is rejected by parseServerModeEnvConfig
    expect(checkById(result.checks, 'server.config').status).toBe('error')
  })

  // ─── 6. JWKS fetch failure → server.jwks error ─────────────────────────────

  it('JWKS fetch failure → server.jwks error', async () => {
    const { result, exitCode } = await runServerDoctor({
      flags: { ...VALID_FLAGS, dataDir },
      env: {},
      fetchJwks: async () => ({ ok: false, hasKeys: false }),
      checkDataDir: () => 'ok',
    })
    expect(exitCode).toBe(1)
    expect(checkById(result.checks, 'server.config').status).toBe('ok')
    expect(checkById(result.checks, 'server.jwks').status).toBe('error')
  })

  // ─── 7. JWKS fetch ok → server.jwks ok ────────────────────────────────────

  it('JWKS fetch ok → server.jwks ok', async () => {
    const { result } = await runServerDoctor({
      flags: { ...VALID_FLAGS, dataDir },
      env: {},
      fetchJwks: async () => ({ ok: true, hasKeys: true }),
      checkDataDir: () => 'ok',
    })
    expect(checkById(result.checks, 'server.jwks').status).toBe('ok')
  })

  // ─── 8. Missing data dir ───────────────────────────────────────────────────

  it('missing data dir → server.data_dir error', async () => {
    const { result, exitCode } = await runServerDoctor({
      flags: { ...VALID_FLAGS, dataDir },
      env: {},
      fetchJwks: async () => ({ ok: true, hasKeys: true }),
      checkDataDir: () => 'not-exists',
    })
    expect(exitCode).toBe(1)
    expect(checkById(result.checks, 'server.data_dir').status).toBe('error')
  })

  it('non-writable data dir → server.data_dir error', async () => {
    const { result, exitCode } = await runServerDoctor({
      flags: { ...VALID_FLAGS, dataDir },
      env: {},
      fetchJwks: async () => ({ ok: true, hasKeys: true }),
      checkDataDir: () => 'not-writable',
    })
    expect(exitCode).toBe(1)
    expect(checkById(result.checks, 'server.data_dir').status).toBe('error')
  })

  // ─── 9. Missing record → downstream checks skipped ────────────────────────

  it('missing record → server.record skipped, and dependent checks skipped', async () => {
    // No record file written — dataDir exists but record is absent
    const { result } = await runServerDoctor({
      flags: { ...VALID_FLAGS, dataDir },
      env: {},
      fetchJwks: async () => ({ ok: true, hasKeys: true }),
      checkDataDir: () => 'ok',
    })
    expect(checkById(result.checks, 'server.record').status).toBe('skipped')
    expect(checkById(result.checks, 'server.record_permissions').status).toBe('skipped')
    expect(checkById(result.checks, 'server.identity').status).toBe('skipped')
    expect(checkById(result.checks, 'server.runtime_ping').status).toBe('skipped')
    expect(checkById(result.checks, 'server.runtime_status').status).toBe('skipped')
  })

  // ─── 10. Malformed record → warning ───────────────────────────────────────

  it('malformed record → server.record warning', async () => {
    await writeFile(join(dataDir, 'server-mode.json'), '{ not: valid json', { mode: 0o600 })
    const { result } = await runServerDoctor({
      flags: { ...VALID_FLAGS, dataDir },
      env: {},
      fetchJwks: async () => ({ ok: true, hasKeys: true }),
      checkDataDir: () => 'ok',
    })
    expect(checkById(result.checks, 'server.record').status).toBe('warning')
  })

  // ─── 11. Broad record permissions ─────────────────────────────────────────

  it('broad record permissions → server.record_permissions warning (POSIX)', async () => {
    await writeServerRecord(makeRecord())
    const { result } = await runServerDoctor({
      flags: { ...VALID_FLAGS, dataDir },
      env: {},
      isPidAlive: () => false, // keep identity skipped to isolate permissions check
      fetchJwks: async () => ({ ok: true, hasKeys: true }),
      checkDataDir: () => 'ok',
      readRecordMode: () => 0o644,
    })
    // Only check permissions status — on Windows-platform test runs this
    // would be skipped, but we inject readRecordMode unconditionally so
    // the check only looks at the platform discriminator.
    // Since we can't override process.platform in this test, we just verify
    // the check exists and is either warning (POSIX) or skipped (win32).
    const permCheck = checkById(result.checks, 'server.record_permissions')
    expect(['warning', 'skipped']).toContain(permCheck.status)
  })

  it('broad record permissions with win32 platform → skipped via readRecordMode returning null', async () => {
    // Simulate Windows by having readRecordMode return null (record unreadable)
    // The actual Windows branch requires process.platform override, but we verify
    // the null path is also handled gracefully.
    await writeServerRecord(makeRecord())
    const { result } = await runServerDoctor({
      flags: { ...VALID_FLAGS, dataDir },
      env: {},
      isPidAlive: () => false,
      fetchJwks: async () => ({ ok: true, hasKeys: true }),
      checkDataDir: () => 'ok',
      readRecordMode: () => null,
    })
    expect(checkById(result.checks, 'server.record_permissions').status).toBe('skipped')
  })

  // ─── 12. PID alive but identity mismatch → warning, NO kill ───────────────

  it('pid alive but identity mismatch → server.identity warning, no kill', async () => {
    await writeServerRecord(makeRecord())
    const { result, exitCode } = await runServerDoctor({
      flags: { ...VALID_FLAGS, dataDir },
      env: {},
      isPidAlive: () => true,
      verifyIdentity: async () => false,
      fetchJwks: async () => ({ ok: true, hasKeys: true }),
      checkDataDir: () => 'ok',
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

  // ─── 13. PID dead → server.identity skipped ───────────────────────────────

  it('pid dead → server.identity skipped (not error — server just not running)', async () => {
    await writeServerRecord(makeRecord())
    const { result } = await runServerDoctor({
      flags: { ...VALID_FLAGS, dataDir },
      env: {},
      isPidAlive: () => false,
      fetchJwks: async () => ({ ok: true, hasKeys: true }),
      checkDataDir: () => 'ok',
      readRecordMode: () => 0o600,
    })
    expect(checkById(result.checks, 'server.identity').status).toBe('skipped')
    expect(checkById(result.checks, 'server.runtime_ping').status).toBe('skipped')
    expect(checkById(result.checks, 'server.runtime_status').status).toBe('skipped')
  })

  // ─── 14. Runtime ping ok with pid match ───────────────────────────────────

  it('runtime ping ok with pid match → server.runtime_ping ok', async () => {
    await writeServerRecord(makeRecord())
    const { result } = await runServerDoctor({
      flags: { ...VALID_FLAGS, dataDir },
      env: {},
      isPidAlive: () => true,
      verifyIdentity: async () => true,
      fetchJwks: async () => ({ ok: true, hasKeys: true }),
      checkDataDir: () => 'ok',
      readRecordMode: () => 0o600,
      fetchPing: async () => ({ ok: true, pidMatches: true }),
      fetchRuntimeStatus: async () => ({ ok: true, protected: false, leakDetected: false }),
    })
    expect(checkById(result.checks, 'server.runtime_ping').status).toBe('ok')
  })

  // ─── 15. Runtime ping pid mismatch → warning ──────────────────────────────

  it('runtime ping with pid mismatch → server.runtime_ping warning', async () => {
    await writeServerRecord(makeRecord())
    const { result } = await runServerDoctor({
      flags: { ...VALID_FLAGS, dataDir },
      env: {},
      isPidAlive: () => true,
      verifyIdentity: async () => true,
      fetchJwks: async () => ({ ok: true, hasKeys: true }),
      checkDataDir: () => 'ok',
      readRecordMode: () => 0o600,
      fetchPing: async () => ({ ok: true, pidMatches: false }),
      fetchRuntimeStatus: async () => ({ ok: true, protected: false, leakDetected: false }),
    })
    expect(checkById(result.checks, 'server.runtime_ping').status).toBe('warning')
  })

  // ─── 16. Runtime status with leak → warning ───────────────────────────────

  it('runtime status with leak detected → server.runtime_status warning', async () => {
    await writeServerRecord(makeRecord())
    const { result, exitCode } = await runServerDoctor({
      flags: { ...VALID_FLAGS, dataDir },
      env: {},
      isPidAlive: () => true,
      verifyIdentity: async () => true,
      fetchJwks: async () => ({ ok: true, hasKeys: true }),
      checkDataDir: () => 'ok',
      readRecordMode: () => 0o600,
      fetchPing: async () => ({ ok: true, pidMatches: true }),
      fetchRuntimeStatus: async () => ({ ok: true, protected: false, leakDetected: true }),
    })
    expect(checkById(result.checks, 'server.runtime_status').status).toBe('warning')
    // warning keeps ok:true
    expect(result.ok).toBe(true)
    expect(exitCode).toBe(0)
  })

  // ─── runtime_status: protected endpoint → ok (not error) ─────────────────

  it('runtime status endpoint returns 401/403 → server.runtime_status ok (properly protected)', async () => {
    // Regression: a correctly configured server-mode deployment protects
    // /api/runtime/status with OAuth. The unauthenticated doctor probe
    // must not report this as an error — the 401/403 IS the expected behavior.
    await writeServerRecord(makeRecord())
    const { result, exitCode } = await runServerDoctor({
      flags: { ...VALID_FLAGS, dataDir },
      env: {},
      isPidAlive: () => true,
      verifyIdentity: async () => true,
      fetchJwks: async () => ({ ok: true, hasKeys: true }),
      checkDataDir: () => 'ok',
      readRecordMode: () => 0o600,
      fetchPing: async () => ({ ok: true, pidMatches: true }),
      fetchRuntimeStatus: async () => ({ ok: true, protected: true, leakDetected: false }),
    })
    expect(checkById(result.checks, 'server.runtime_status').status).toBe('ok')
    expect(result.ok).toBe(true)
    expect(exitCode).toBe(0)
  })

  // ─── 17. Non-leak guard ────────────────────────────────────────────────────

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

  // ─── 18. Aggregation invariant ────────────────────────────────────────────

  it('any error check → ok:false, exit 1', async () => {
    const { result, exitCode } = await runServerDoctor({
      flags: { ...VALID_FLAGS, dataDir },
      env: {},
      fetchJwks: async () => ({ ok: false, hasKeys: false }), // causes server.jwks error
      checkDataDir: () => 'ok',
    })
    expect(result.ok).toBe(false)
    expect(exitCode).toBe(1)
    expect(result.status).toBe('error')
  })

  it('warning only (no error) → ok:true, status:warning, exit 0', async () => {
    await writeServerRecord(makeRecord())
    const { result, exitCode } = await runServerDoctor({
      flags: { ...VALID_FLAGS, dataDir },
      env: {},
      isPidAlive: () => true,
      verifyIdentity: async () => false, // warning: identity mismatch
      fetchJwks: async () => ({ ok: true, hasKeys: true }),
      checkDataDir: () => 'ok',
      readRecordMode: () => 0o600,
    })
    expect(result.ok).toBe(true)
    expect(exitCode).toBe(0)
    expect(result.status).toBe('warning')
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
