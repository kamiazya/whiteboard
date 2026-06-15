import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RunServerDoctorOutcome } from './server-doctor.js'
import type { RunServerStatusOutcome } from './server-status.js'
import { runServerSupportBundle } from './server-support-bundle.js'

let tmpRoot: string

beforeEach(async () => {
  // Canonicalize so paths don't traverse system-level symlinks
  // (e.g. /var → /private/var on macOS) that would trip the ancestor-symlink guard.
  tmpRoot = await realpath(await mkdtemp(join(tmpdir(), 'wb-server-support-bundle-test-')))
})
afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true })
})

const FIXED_TS = '2026-05-21T00:00:00.000Z'

function makeStatusOutcome(state: 'running' | 'missing' | 'stale' | 'malformed'): RunServerStatusOutcome {
  if (state === 'running') {
    return {
      result: {
        schemaVersion: 1,
        ok: true,
        state: 'running',
        pid: 42,
        host: '127.0.0.1',
        port: 3099,
        publicBaseUrl: 'https://whiteboard.example.com',
        authStrategy: 'oauth-jwt',
        startedAt: FIXED_TS,
        recordFresh: true,
      },
      exitCode: 0,
    }
  }
  return { result: { schemaVersion: 1, ok: false, state, recordFresh: false }, exitCode: 1 }
}

function makeDoctorOutcome(ok = true): RunServerDoctorOutcome {
  return {
    result: {
      schemaVersion: 1,
      ok,
      status: ok ? 'ok' : 'error',
      checks: [
        { id: 'server.config', status: ok ? 'ok' : 'error', summary: 'Server config check' },
      ],
    },
    exitCode: ok ? 0 : 1,
  }
}

const defaultSeams = {
  doRunStatus: vi.fn(async () => makeStatusOutcome('missing')),
  doRunDoctor: vi.fn(async () => makeDoctorOutcome()),
  doReadRecord: vi.fn(() => ({ kind: 'missing' as const })),
}

describe('runServerSupportBundle', () => {
  it('success: missing record + missing output dir → exit 0, 4 files on disk', async () => {
    const dataDir = join(tmpRoot, 'data')
    const outputDir = join(tmpRoot, 'bundle-out')

    const outcome = await runServerSupportBundle({
      dataDir,
      outputDir,
      now: () => FIXED_TS,
      packageVersion: '0.0.4-test',
      platform: { os: 'linux', nodeVersion: 'v22.0.0' },
      ...defaultSeams,
    })

    expect(outcome.exitCode).toBe(0)
    expect(outcome.stderr).toBe('')
    expect(outcome.stdout.endsWith('\n')).toBe(true)

    const result = JSON.parse(outcome.stdout.trim())
    expect(result.schemaVersion).toBe(1)
    expect(result.ok).toBe(true)
    expect(result.operation).toBe('support-bundle')
    expect(result.files).toEqual(['status.json', 'doctor.json', 'record.json', 'manifest.json'])
    expect(result).not.toHaveProperty('outputDir')

    const onDisk = (await readdir(outputDir)).sort()
    expect(onDisk).toEqual(['doctor.json', 'manifest.json', 'record.json', 'status.json'])
  })

  it('success: manifest written last with correct fields', async () => {
    const outputDir = join(tmpRoot, 'manifest-check')

    const outcome = await runServerSupportBundle({
      dataDir: join(tmpRoot, 'data'),
      outputDir,
      now: () => FIXED_TS,
      packageVersion: '0.0.4-test',
      platform: { os: 'linux', nodeVersion: 'v22.0.0' },
      ...defaultSeams,
    })

    expect(outcome.exitCode).toBe(0)
    const manifest = JSON.parse(await readFile(join(outputDir, 'manifest.json'), 'utf-8'))
    expect(manifest.schemaVersion).toBe(1)
    expect(manifest.createdAt).toBe(FIXED_TS)
    expect(manifest.packageVersion).toBe('0.0.4-test')
    expect(manifest.platform).toEqual({ os: 'linux', nodeVersion: 'v22.0.0' })
    expect(manifest.mode).toBe('server-mode')
    expect(manifest.sections).toEqual(['status.json', 'doctor.json', 'record.json'])
  })

  it('success: existing empty output dir is accepted', async () => {
    const outputDir = join(tmpRoot, 'empty-out')
    await mkdir(outputDir)

    const outcome = await runServerSupportBundle({
      dataDir: join(tmpRoot, 'data'),
      outputDir,
      now: () => FIXED_TS,
      ...defaultSeams,
    })

    expect(outcome.exitCode).toBe(0)
  })

  it('success: running record → status section reflects running state', async () => {
    const outputDir = join(tmpRoot, 'running-out')

    const outcome = await runServerSupportBundle({
      dataDir: join(tmpRoot, 'data'),
      outputDir,
      now: () => FIXED_TS,
      doRunStatus: vi.fn(async () => makeStatusOutcome('running')),
      doRunDoctor: vi.fn(async () => makeDoctorOutcome()),
      doReadRecord: vi.fn(() => ({
        kind: 'ok' as const,
        record: {
          schemaVersion: 1 as const,
          pid: 42,
          host: '127.0.0.1',
          port: 3099,
          publicBaseUrl: 'https://whiteboard.example.com',
          authStrategy: 'oauth-jwt' as const,
          startedAt: FIXED_TS,
        },
      })),
    })

    expect(outcome.exitCode).toBe(0)
    const status = JSON.parse(await readFile(join(outputDir, 'status.json'), 'utf-8'))
    expect(status.state).toBe('running')
    expect(status.ok).toBe(true)
    expect(status.pid).toBe(42)
    expect(status.port).toBe(3099)
    expect(status.authStrategy).toBe('oauth-jwt')
    expect(status.startedAt).toBe(FIXED_TS)
    // No internal bind host or publicBaseUrl in status section.
    expect(status).not.toHaveProperty('host')
    expect(status).not.toHaveProperty('publicBaseUrl')
  })

  it('success: valid record → record.json contains allow-listed fields, publicBaseUrl stripped to host', async () => {
    const outputDir = join(tmpRoot, 'record-out')

    const outcome = await runServerSupportBundle({
      dataDir: join(tmpRoot, 'data'),
      outputDir,
      now: () => FIXED_TS,
      doRunStatus: vi.fn(async () => makeStatusOutcome('missing')),
      doRunDoctor: vi.fn(async () => makeDoctorOutcome()),
      doReadRecord: vi.fn(() => ({
        kind: 'ok' as const,
        record: {
          schemaVersion: 1 as const,
          pid: 42,
          host: '0.0.0.0',
          port: 3099,
          publicBaseUrl: 'https://whiteboard.example.com/app?token=secret',
          authStrategy: 'oauth-jwt' as const,
          startedAt: FIXED_TS,
        },
      })),
    })

    expect(outcome.exitCode).toBe(0)
    const record = JSON.parse(await readFile(join(outputDir, 'record.json'), 'utf-8'))
    expect(record.kind).toBe('stale')
    expect(record.pid).toBe(42)
    expect(record.port).toBe(3099)
    expect(record.authStrategy).toBe('oauth-jwt')
    expect(record.startedAt).toBe(FIXED_TS)
    // Host only — path/query/creds stripped.
    expect(record.publicBaseUrlHost).toBe('whiteboard.example.com')
    expect(JSON.stringify(record)).not.toContain('token=secret')
    expect(JSON.stringify(record)).not.toContain('/app')
    // Internal bind host must not appear.
    expect(JSON.stringify(record)).not.toContain('0.0.0.0')
  })

  it('success: stale record → kind stale, no raw path', async () => {
    const outputDir = join(tmpRoot, 'stale-out')

    await runServerSupportBundle({
      dataDir: join(tmpRoot, 'data'),
      outputDir,
      now: () => FIXED_TS,
      doRunStatus: vi.fn(async () => makeStatusOutcome('stale')),
      doRunDoctor: vi.fn(async () => makeDoctorOutcome()),
      doReadRecord: vi.fn(() => ({
        kind: 'ok' as const,
        record: {
          schemaVersion: 1 as const,
          pid: 99999,
          host: '127.0.0.1',
          port: 3099,
          publicBaseUrl: 'https://whiteboard.example.com',
          authStrategy: 'oauth-jwt' as const,
          startedAt: FIXED_TS,
        },
      })),
    })

    const record = JSON.parse(await readFile(join(outputDir, 'record.json'), 'utf-8'))
    expect(record.kind).toBe('stale')
  })

  it('success: malformed record → record.json safe representation', async () => {
    const outputDir = join(tmpRoot, 'malformed-out')

    const outcome = await runServerSupportBundle({
      dataDir: join(tmpRoot, 'data'),
      outputDir,
      now: () => FIXED_TS,
      ...defaultSeams,
      doReadRecord: vi.fn(() => ({ kind: 'malformed' as const })),
    })

    expect(outcome.exitCode).toBe(0)
    const record = JSON.parse(await readFile(join(outputDir, 'record.json'), 'utf-8'))
    expect(record.kind).toBe('malformed')
    expect(Object.keys(record)).toEqual(['schemaVersion', 'kind'])
  })

  it('success: doctor section written with check id/status/summary', async () => {
    const outputDir = join(tmpRoot, 'doctor-out')

    const outcome = await runServerSupportBundle({
      dataDir: join(tmpRoot, 'data'),
      outputDir,
      now: () => FIXED_TS,
      ...defaultSeams,
      doRunDoctor: vi.fn(async () => ({
        result: {
          schemaVersion: 1 as const,
          ok: false,
          status: 'error' as const,
          checks: [
            { id: 'server.config', status: 'error' as const, summary: 'Server config is invalid' },
          ],
        },
        exitCode: 1 as const,
      })),
    })

    expect(outcome.exitCode).toBe(0)
    const doctor = JSON.parse(await readFile(join(outputDir, 'doctor.json'), 'utf-8'))
    expect(doctor.ok).toBe(false)
    expect(doctor.status).toBe('error')
    expect(doctor.checks[0].id).toBe('server.config')
    expect(doctor.checks[0].status).toBe('error')
  })

  it('non-empty output dir → exit 1, generic stderr, no partial writes', async () => {
    const outputDir = join(tmpRoot, 'non-empty')
    await mkdir(outputDir)
    await writeFile(join(outputDir, 'canary.txt'), 'content')

    const outcome = await runServerSupportBundle({
      dataDir: join(tmpRoot, 'data'),
      outputDir,
      now: () => FIXED_TS,
      ...defaultSeams,
    })

    expect(outcome.exitCode).toBe(1)
    expect(outcome.stdout).toBe('')
    expect(outcome.stderr).toMatch(/output directory must be empty/i)
    // Canary preserved, no bundle files written.
    expect((await readdir(outputDir)).sort()).toEqual(['canary.txt'])
  })

  it('symlink final component → exit 1', async () => {
    const realDir = join(tmpRoot, 'real')
    const linkPath = join(tmpRoot, 'link')
    await mkdir(realDir)
    await symlink(realDir, linkPath)

    const outcome = await runServerSupportBundle({
      dataDir: join(tmpRoot, 'data'),
      outputDir: linkPath,
      now: () => FIXED_TS,
      ...defaultSeams,
    })

    expect(outcome.exitCode).toBe(1)
    expect(outcome.stdout).toBe('')
  })

  it('ancestor symlink in output path → exit 1', async () => {
    const realDir = join(tmpRoot, 'real-anc')
    const linkDir = join(tmpRoot, 'link-anc')
    await mkdir(realDir)
    await symlink(realDir, linkDir)

    const outcome = await runServerSupportBundle({
      dataDir: join(tmpRoot, 'data'),
      outputDir: join(linkDir, 'bundle'),
      now: () => FIXED_TS,
      ...defaultSeams,
    })

    expect(outcome.exitCode).toBe(1)
    expect(outcome.stdout).toBe('')
  })

  it('non-leak: stdout/stderr do not contain raw paths, tokens, Authorization, Bearer', async () => {
    const dataDir = join(tmpRoot, 'leak-data')
    const outputDir = join(tmpRoot, 'leak-out')

    const outcome = await runServerSupportBundle({
      dataDir,
      outputDir,
      now: () => FIXED_TS,
      ...defaultSeams,
    })

    const combined = outcome.stdout + outcome.stderr
    expect(combined).not.toMatch(new RegExp(tmpRoot.replace(/[/\\]/g, '.')))
    expect(combined).not.toMatch(/Authorization/i)
    expect(combined).not.toMatch(/Bearer/i)
    expect(combined).not.toMatch(/stack/i)
  })

  it('non-leak: bundle files do not contain raw path, Authorization, Bearer, stack trace', async () => {
    const outputDir = join(tmpRoot, 'file-leak-out')

    const outcome = await runServerSupportBundle({
      dataDir: join(tmpRoot, 'data'),
      outputDir,
      now: () => FIXED_TS,
      packageVersion: '0.0.4-test',
      platform: { os: 'linux', nodeVersion: 'v22.0.0' },
      ...defaultSeams,
      doRunDoctor: vi.fn(async () => ({
        result: {
          schemaVersion: 1 as const,
          ok: false,
          status: 'error' as const,
          checks: [
            {
              id: 'server.config',
              status: 'error' as const,
              summary: 'Server config is invalid',
              detail: `Config error: code=missing-required-fields`,
            },
          ],
        },
        exitCode: 1 as const,
      })),
    })

    expect(outcome.exitCode).toBe(0)
    const files = ['manifest.json', 'status.json', 'doctor.json', 'record.json']
    const concatenated = (
      await Promise.all(files.map((f) => readFile(join(outputDir, f), 'utf-8')))
    ).join('')
    expect(concatenated).not.toMatch(/Authorization/i)
    expect(concatenated).not.toMatch(/Bearer/i)
    expect(concatenated).not.toMatch(new RegExp(tmpRoot.replace(/[/\\]/g, '.')))
    expect(concatenated).not.toMatch(/\.ts:\d/)
  })

  it('doctor redaction: auth markers in check fields are scrubbed from bundle', async () => {
    const outputDir = join(tmpRoot, 'doctor-redact-out')

    await runServerSupportBundle({
      dataDir: join(tmpRoot, 'data'),
      outputDir,
      now: () => FIXED_TS,
      ...defaultSeams,
      doRunDoctor: vi.fn(async () => ({
        result: {
          schemaVersion: 1 as const,
          ok: false,
          status: 'error' as const,
          checks: [
            {
              id: 'server.auth',
              status: 'error' as const,
              summary: 'Authorization: Bearer sometoken is invalid',
              detail: 'Bearer [REDACTED] was rejected by the JWKS endpoint',
              remediation: 'Rotate the Bearer token and restart',
            },
          ],
        },
        exitCode: 1 as const,
      })),
    })

    const doctor = JSON.parse(await readFile(join(outputDir, 'doctor.json'), 'utf-8'))
    const flat = JSON.stringify(doctor)
    // Auth markers must not appear verbatim — redactStrict scrubs them to [REDACTED_AUTH].
    expect(flat).not.toMatch(/Authorization/i)
    expect(flat).not.toMatch(/\bBearer\b/i)
    expect(flat).toContain('[REDACTED_AUTH]')
    // Structural fields are preserved.
    expect(doctor.checks[0].id).toBe('server.auth')
    expect(doctor.checks[0].status).toBe('error')
  })

  it('record identity: PID-reuse case → record.kind stale when status identity check fails', async () => {
    // The PID is occupied by a different process (reuse scenario). runServerStatus
    // returns 'stale' because verifyIdentity failed, even though isPidAlive would
    // return true. record.kind must follow the identity-verified status outcome.
    const outputDir = join(tmpRoot, 'pid-reuse-out')

    await runServerSupportBundle({
      dataDir: join(tmpRoot, 'data'),
      outputDir,
      now: () => FIXED_TS,
      // Status says stale (identity mismatch) even though PID is alive.
      doRunStatus: vi.fn(async () => makeStatusOutcome('stale')),
      doRunDoctor: vi.fn(async () => makeDoctorOutcome()),
      doReadRecord: vi.fn(() => ({
        kind: 'ok' as const,
        record: {
          schemaVersion: 1 as const,
          pid: 42,
          host: '127.0.0.1',
          port: 3099,
          publicBaseUrl: 'https://whiteboard.example.com',
          authStrategy: 'oauth-jwt' as const,
          startedAt: FIXED_TS,
        },
      })),
    })

    const record = JSON.parse(await readFile(join(outputDir, 'record.json'), 'utf-8'))
    expect(record.kind).toBe('stale')
  })
})
