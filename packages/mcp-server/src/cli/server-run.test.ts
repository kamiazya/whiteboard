import { describe, expect, it, vi } from 'vitest'
import type { StartServerFn } from './server-run.js'
import { runServerRun } from './server-run.js'
import type { ServerRunArgs } from './server-run-args.js'

// Minimal env that satisfies all required fields for a valid server-mode config.
const VALID_ENV: NodeJS.ProcessEnv = {
  WHITEBOARD_SERVER_EXTERNAL_URL: 'https://whiteboard.example.com',
  WHITEBOARD_SERVER_AUTH_STRATEGY: 'oauth-jwt',
  WHITEBOARD_SERVER_JWT_ISSUER: 'https://auth.example.com',
  WHITEBOARD_SERVER_JWT_AUDIENCE: 'https://whiteboard.example.com',
  WHITEBOARD_SERVER_JWKS_URI: 'https://auth.example.com/.well-known/jwks.json',
}

function dryRunFlags(
  overrides: Partial<ServerRunArgs & { kind: 'ok' }> = {},
): ServerRunArgs & { kind: 'ok' } {
  return {
    kind: 'ok',
    json: true,
    dryRun: true,
    trustedProxy: undefined,
    externalUrl: undefined,
    allowedOrigins: undefined,
    authStrategy: undefined,
    jwtIssuer: undefined,
    jwtAudience: undefined,
    jwksUri: undefined,
    jwtClockSkew: undefined,
    jwtScopeClaim: undefined,
    host: undefined,
    port: undefined,
    dataDir: undefined,
    ...overrides,
  }
}

describe('runServerRun — dry-run success', () => {
  it('returns dry-run-ok with correct shape from env', async () => {
    const outcome = await runServerRun({ flags: dryRunFlags(), env: VALID_ENV })
    expect(outcome.kind).toBe('dry-run-ok')
    if (outcome.kind !== 'dry-run-ok') return
    expect(outcome.result.schemaVersion).toBe(1)
    expect(outcome.result.ok).toBe(true)
    expect(outcome.result.dryRun).toBe(true)
    expect(outcome.result.publicBaseUrl).toBe('https://whiteboard.example.com')
    expect(outcome.result.authStrategy).toBe('oauth-jwt')
    expect(outcome.result.allowedOrigins).toEqual(['https://whiteboard.example.com'])
  })

  it('CLI flags override env vars', async () => {
    const outcome = await runServerRun({
      flags: dryRunFlags({
        externalUrl: 'https://cli.example.com',
        jwtAudience: 'cli-aud',
      }),
      env: VALID_ENV,
    })
    expect(outcome.kind).toBe('dry-run-ok')
    if (outcome.kind !== 'dry-run-ok') return
    expect(outcome.result.publicBaseUrl).toBe('https://cli.example.com')
  })

  it('--allowed-origins CLI flag overrides env default', async () => {
    const outcome = await runServerRun({
      flags: dryRunFlags({
        allowedOrigins: 'https://app.example.com,https://admin.example.com',
      }),
      env: VALID_ENV,
    })
    expect(outcome.kind).toBe('dry-run-ok')
    if (outcome.kind !== 'dry-run-ok') return
    expect(outcome.result.allowedOrigins).toEqual([
      'https://app.example.com',
      'https://admin.example.com',
    ])
  })

  it('origin normalization: :443 stripped in plan output', async () => {
    const outcome = await runServerRun({
      flags: dryRunFlags({
        allowedOrigins: 'https://whiteboard.example.com:443',
      }),
      env: VALID_ENV,
    })
    expect(outcome.kind).toBe('dry-run-ok')
    if (outcome.kind !== 'dry-run-ok') return
    expect(outcome.result.allowedOrigins).toEqual(['https://whiteboard.example.com'])
  })

  it('--trusted-proxy flag merges into env', async () => {
    const outcome = await runServerRun({
      flags: dryRunFlags({ trustedProxy: true }),
      env: VALID_ENV,
    })
    // trustedProxy affects the plan but not the dry-run result shape directly
    expect(outcome.kind).toBe('dry-run-ok')
  })
})

describe('runServerRun — config-error', () => {
  it('missing required field → config-error with code and field', async () => {
    const env = { ...VALID_ENV }
    delete env.WHITEBOARD_SERVER_EXTERNAL_URL
    const outcome = await runServerRun({ flags: dryRunFlags(), env })
    expect(outcome.kind).toBe('config-error')
    if (outcome.kind !== 'config-error') return
    expect(outcome.code).toBe('server_mode_env.external_url_required')
    expect(outcome.field).toBe('WHITEBOARD_SERVER_EXTERNAL_URL')
  })

  it('invalid port → config-error', async () => {
    const outcome = await runServerRun({
      flags: dryRunFlags({ port: '99999' }),
      env: VALID_ENV,
    })
    expect(outcome.kind).toBe('config-error')
    if (outcome.kind !== 'config-error') return
    expect(outcome.code).toBe('server_mode_env.port_out_of_range')
  })

  it('non-leak: config-error does not contain raw URL values', async () => {
    const sensitiveEnv = {
      ...VALID_ENV,
      WHITEBOARD_SERVER_JWKS_URI: 'http://user:secret@auth.example.com/jwks',
    }
    const outcome = await runServerRun({ flags: dryRunFlags(), env: sensitiveEnv })
    expect(outcome.kind).toBe('config-error')
    const asText = JSON.stringify(outcome)
    expect(asText).not.toContain('secret')
    expect(asText).not.toContain('auth.example.com')
    expect(asText).not.toContain('user')
  })
})

/**
 * A storage setting the operator configured and this process cannot honour
 * stops the server, rather than starting it on a default nobody asked for.
 *
 * Same posture `server/index.ts` already takes for a malformed
 * WHITEBOARD_ALLOWED_WEB_ORIGINS: a silent fallback "would look identical to
 * 'the operator never configured it'". Setting a value IS the requirement,
 * and starting anyway answers it with behaviour that was not requested.
 */
describe('runServerRun — storage config', () => {
  it('refuses to start when a duration carries a unit suffix', async () => {
    const outcome = await runServerRun({
      flags: dryRunFlags(),
      env: { ...VALID_ENV, WHITEBOARD_FILE_GC_GRACE_MS: '1h' },
    })
    expect(outcome.kind).toBe('config-error')
    if (outcome.kind !== 'config-error') return
    expect(outcome.field).toBe('WHITEBOARD_FILE_GC_GRACE_MS')
  })

  it('starts normally when the storage settings are understood', async () => {
    const outcome = await runServerRun({
      flags: dryRunFlags(),
      env: {
        ...VALID_ENV,
        WHITEBOARD_FILE_GC_GRACE_MS: '3600000',
        WHITEBOARD_WORKSPACE_TAIL_MS: '0',
      },
    })
    expect(outcome.kind).toBe('dry-run-ok')
  })

  it('non-leak: a bad database URL never reaches the outcome', async () => {
    const outcome = await runServerRun({
      flags: dryRunFlags(),
      env: { ...VALID_ENV, WHITEBOARD_DATABASE_URL: 'postgres://user:hunter2@db.example.com' },
    })
    expect(outcome.kind).toBe('config-error')
    const asText = JSON.stringify(outcome)
    expect(asText).not.toContain('hunter2')
    expect(asText).not.toContain('db.example.com')
  })
})

describe('runServerRun — plan-error', () => {
  it('non-HTTPS externalUrl → plan-error', async () => {
    const outcome = await runServerRun({
      flags: dryRunFlags({ externalUrl: 'http://whiteboard.example.com' }),
      env: VALID_ENV,
    })
    expect(outcome.kind).toBe('plan-error')
    if (outcome.kind !== 'plan-error') return
    expect(outcome.code).toBe('server_mode.external_url_must_be_https')
  })

  it('externalUrl with path → plan-error', async () => {
    const outcome = await runServerRun({
      flags: dryRunFlags({ externalUrl: 'https://whiteboard.example.com/some/path' }),
      env: VALID_ENV,
    })
    expect(outcome.kind).toBe('plan-error')
  })

  it('non-leak: plan-error does not contain raw URL', async () => {
    const outcome = await runServerRun({
      flags: dryRunFlags({ externalUrl: 'http://user:pass@example.com' }),
      env: VALID_ENV,
    })
    expect(outcome.kind).toBe('plan-error')
    const asText = JSON.stringify(outcome)
    expect(asText).not.toContain('pass')
    expect(asText).not.toContain('user')
    expect(asText).not.toContain('example.com')
  })
})

describe('runServerRun — actual run (no --dry-run)', () => {
  function mockStartServer(overrides: Partial<{ failWith: Error }> = {}): StartServerFn {
    return async (opts) => {
      if (overrides.failWith) throw overrides.failWith
      return {
        port: opts.port,
        host: opts.host,
        startedAt: new Date().toISOString(),
        resolvedDataDir: '/tmp/mock-server-data',
        instanceId: 'mock-instance-id',
        close: async () => {},
      }
    }
  }

  it('returns running with correct ready result shape', async () => {
    const outcome = await runServerRun({
      flags: dryRunFlags({ dryRun: false }),
      env: VALID_ENV,
      startServer: mockStartServer(),
      writeRecord: vi.fn(),
      deleteRecord: vi.fn(),
    })
    expect(outcome.kind).toBe('running')
    if (outcome.kind !== 'running') return
    expect(outcome.result.schemaVersion).toBe(1)
    expect(outcome.result.ok).toBe(true)
    expect(outcome.result.pid).toBe(process.pid)
    expect(outcome.result.publicBaseUrl).toBe('https://whiteboard.example.com')
    expect(outcome.result.authStrategy).toBe('oauth-jwt')
    expect(typeof outcome.result.startedAt).toBe('string')
    expect(typeof outcome.result.host).toBe('string')
    expect(typeof outcome.result.port).toBe('number')
    expect(typeof outcome.close).toBe('function')
  })

  it('passes config-derived host/port to startServer', async () => {
    let capturedHost: string | undefined
    let capturedPort: number | undefined
    const startServer: StartServerFn = async (opts) => {
      capturedHost = opts.host
      capturedPort = opts.port
      return {
        port: opts.port,
        host: opts.host,
        startedAt: new Date().toISOString(),
        resolvedDataDir: '/tmp/mock',
        instanceId: 'mock-instance-id',
        close: async () => {},
      }
    }
    await runServerRun({
      flags: dryRunFlags({ dryRun: false, host: '127.0.0.1', port: '4399' }),
      env: VALID_ENV,
      startServer,
    })
    expect(capturedHost).toBe('127.0.0.1')
    expect(capturedPort).toBe(4399)
  })

  it('passes plan-derived publicBaseUrl and allowedOrigins to startServer', async () => {
    let capturedPublicBaseUrl: string | undefined
    let capturedAllowedOrigins: readonly string[] | undefined
    const startServer: StartServerFn = async (opts) => {
      capturedPublicBaseUrl = opts.publicBaseUrl
      capturedAllowedOrigins = opts.allowedOrigins
      return {
        port: opts.port,
        host: opts.host,
        startedAt: new Date().toISOString(),
        resolvedDataDir: '/tmp/mock',
        instanceId: 'mock-instance-id',
        close: async () => {},
      }
    }
    await runServerRun({
      flags: dryRunFlags({ dryRun: false }),
      env: VALID_ENV,
      startServer,
    })
    expect(capturedPublicBaseUrl).toBe('https://whiteboard.example.com')
    expect(capturedAllowedOrigins).toEqual(['https://whiteboard.example.com'])
  })

  it('returns start-error when startServer throws', async () => {
    const outcome = await runServerRun({
      flags: dryRunFlags({ dryRun: false }),
      env: VALID_ENV,
      startServer: mockStartServer({ failWith: new Error('EADDRINUSE: port already in use') }),
    })
    expect(outcome.kind).toBe('start-error')
  })

  it('non-leak: start-error outcome contains no raw values', async () => {
    const outcome = await runServerRun({
      flags: dryRunFlags({ dryRun: false }),
      env: VALID_ENV,
      startServer: mockStartServer({ failWith: new Error('EADDRINUSE') }),
    })
    expect(outcome.kind).toBe('start-error')
    const asText = JSON.stringify(outcome)
    expect(asText).not.toContain('whiteboard.example.com')
    expect(asText).not.toContain('auth.example.com')
  })

  it('record is written after successful start', async () => {
    const writeRecord = vi.fn()
    const outcome = await runServerRun({
      flags: dryRunFlags({ dryRun: false }),
      env: VALID_ENV,
      startServer: mockStartServer(),
      writeRecord,
    })
    expect(outcome.kind).toBe('running')
    expect(writeRecord).toHaveBeenCalledOnce()
    const [, record] = writeRecord.mock.calls[0]
    expect(record.pid).toBe(process.pid)
    expect(record.publicBaseUrl).toBe('https://whiteboard.example.com')
    expect(record.authStrategy).toBe('oauth-jwt')
    expect(typeof record.startedAt).toBe('string')
    expect(typeof record.port).toBe('number')
    expect(record.instanceId).toBe('mock-instance-id')
  })

  it('record write failure → start-error and server closed', async () => {
    const closeFn = vi.fn()
    const startServer: StartServerFn = async (opts) => ({
      port: opts.port,
      host: opts.host,
      startedAt: new Date().toISOString(),
      resolvedDataDir: '/tmp/mock',
      instanceId: 'mock-instance-id',
      close: closeFn,
    })
    const outcome = await runServerRun({
      flags: dryRunFlags({ dryRun: false }),
      env: VALID_ENV,
      startServer,
      writeRecord: vi.fn().mockImplementationOnce(() => {
        throw new Error('EROFS')
      }),
      deleteRecord: vi.fn(),
    })
    expect(outcome.kind).toBe('start-error')
    expect(closeFn).toHaveBeenCalledOnce()
  })

  it('record is NOT written on start-error', async () => {
    const writeRecord = vi.fn()
    const outcome = await runServerRun({
      flags: dryRunFlags({ dryRun: false }),
      env: VALID_ENV,
      startServer: mockStartServer({ failWith: new Error('EADDRINUSE') }),
      writeRecord,
    })
    expect(outcome.kind).toBe('start-error')
    expect(writeRecord).not.toHaveBeenCalled()
  })

  it('record is written to resolvedDataDir from startServer (not the env/default data dir)', async () => {
    const writeRecord = vi.fn()
    const customDataDir = '/tmp/custom-resolved-server-data'
    const startServer: StartServerFn = async (opts) => ({
      port: opts.port,
      host: opts.host,
      startedAt: new Date().toISOString(),
      resolvedDataDir: customDataDir,
      instanceId: 'mock-instance-id',
      close: async () => {},
    })
    const outcome = await runServerRun({
      flags: dryRunFlags({ dryRun: false }),
      env: VALID_ENV,
      startServer,
      writeRecord,
      deleteRecord: vi.fn(),
    })
    expect(outcome.kind).toBe('running')
    expect(writeRecord).toHaveBeenCalledOnce()
    const [calledDataDir] = writeRecord.mock.calls[0]
    expect(calledDataDir).toBe(customDataDir)
  })

  it('close() deletes the record', async () => {
    const deleteRecord = vi.fn()
    const outcome = await runServerRun({
      flags: dryRunFlags({ dryRun: false }),
      env: VALID_ENV,
      startServer: mockStartServer(),
      writeRecord: vi.fn(),
      deleteRecord,
    })
    expect(outcome.kind).toBe('running')
    if (outcome.kind !== 'running') return
    await outcome.close()
    expect(deleteRecord).toHaveBeenCalledOnce()
  })
})
