import { describe, expect, it, vi } from 'vitest'

// Pin runtime contracts for `whiteboard server status`, `whiteboard server stop`,
// and `whiteboard server doctor` at the dispatcher boundary.
// Mocks the pure helpers so no real files are needed.

vi.mock('./server-status.js', () => ({
  runServerStatus: vi.fn(async () => ({
    result: {
      schemaVersion: 1,
      ok: true,
      state: 'running',
      pid: 42,
      host: '0.0.0.0',
      port: 3099,
      publicBaseUrl: 'https://whiteboard.example.com',
      authStrategy: 'oauth-jwt',
      startedAt: '2026-05-19T00:00:00.000Z',
      recordFresh: true,
    },
    exitCode: 0,
  })),
}))

vi.mock('./server-stop.js', () => ({
  runServerStop: vi.fn(async () => ({
    result: {
      schemaVersion: 1,
      ok: true,
      action: 'stopped',
      reason: null,
      recordFound: true,
      recordFresh: true,
      pid: 42,
    },
    exitCode: 0,
  })),
}))

vi.mock('./server-doctor.js', () => ({
  runServerDoctor: vi.fn(async () => ({
    result: {
      schemaVersion: 1,
      ok: true,
      status: 'ok',
      checks: [
        { id: 'server.config', status: 'ok', summary: 'Server config is valid' },
        { id: 'server.exposure', status: 'ok', summary: 'Server exposure plan is valid' },
        { id: 'server.jwks', status: 'ok', summary: 'JWKS endpoint is reachable and has keys' },
        { id: 'server.data_dir', status: 'ok', summary: 'Data directory is writable' },
        { id: 'server.record', status: 'ok', summary: 'Server record found and valid' },
        {
          id: 'server.record_permissions',
          status: 'ok',
          summary: 'Server record permissions are restricted',
        },
        { id: 'server.identity', status: 'ok', summary: 'Server process identity confirmed' },
        { id: 'server.runtime_ping', status: 'ok', summary: 'Runtime ping responded successfully' },
        {
          id: 'server.runtime_status',
          status: 'ok',
          summary: 'Runtime status endpoint responded without detected leaks',
        },
      ],
    },
    exitCode: 0,
  })),
}))

const statusModule = await import('./server-status.js')
const stopModule = await import('./server-stop.js')
const doctorModule = await import('./server-doctor.js')
const { main, USAGE } = await import('./dispatcher.js')

function captureStdio<T>(
  body: () => Promise<T>,
): Promise<{ result: T; stdout: string; stderr: string }> {
  const stdoutChunks: string[] = []
  const stderrChunks: string[] = []
  const writeStdout = vi
    .spyOn(process.stdout, 'write')
    .mockImplementation((chunk: string | Uint8Array) => {
      stdoutChunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'))
      return true
    })
  const writeStderr = vi
    .spyOn(process.stderr, 'write')
    .mockImplementation((chunk: string | Uint8Array) => {
      stderrChunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'))
      return true
    })
  return body()
    .then((result) => ({ result, stdout: stdoutChunks.join(''), stderr: stderrChunks.join('') }))
    .finally(() => {
      writeStdout.mockRestore()
      writeStderr.mockRestore()
    })
}

describe('CLI dispatcher: whiteboard server status', () => {
  it('running: stdout single JSON object, stderr empty, exit 0', async () => {
    const {
      result: exitCode,
      stdout,
      stderr,
    } = await captureStdio(() => main(['server', 'status', '--json']))
    expect(exitCode).toBe(0)
    expect(stderr).toBe('')
    const parsed = JSON.parse(stdout)
    expect(parsed.ok).toBe(true)
    expect(parsed.state).toBe('running')
    expect(parsed.schemaVersion).toBe(1)
  })

  it('missing --json → exit 64, stdout empty, stderr contains usage hint', async () => {
    const {
      result: exitCode,
      stdout,
      stderr,
    } = await captureStdio(() => main(['server', 'status']))
    expect(exitCode).toBe(64)
    expect(stdout).toBe('')
    expect(stderr).toMatch(/--json/)
  })

  it('not-running: stdout JSON with ok:false, exit 1', async () => {
    vi.mocked(statusModule.runServerStatus).mockResolvedValueOnce({
      result: {
        schemaVersion: 1,
        ok: false,
        state: 'missing',
        recordFresh: false,
      },
      exitCode: 1,
    })
    const { result: exitCode, stdout } = await captureStdio(() =>
      main(['server', 'status', '--json']),
    )
    expect(exitCode).toBe(1)
    const parsed = JSON.parse(stdout)
    expect(parsed.ok).toBe(false)
    expect(parsed.state).toBe('missing')
  })

  it('stdout is always a single JSON line with trailing newline', async () => {
    const { result: exitCode, stdout } = await captureStdio(() =>
      main(['server', 'status', '--json']),
    )
    expect(exitCode).toBe(0)
    expect(stdout.endsWith('\n')).toBe(true)
    expect(stdout.trim().split('\n')).toHaveLength(1)
  })

  it('USAGE constant includes whiteboard server status', () => {
    expect(USAGE).toMatch(/whiteboard server status/)
  })
})

describe('CLI dispatcher: whiteboard server stop', () => {
  it('stopped: stdout single JSON object, stderr empty, exit 0', async () => {
    const {
      result: exitCode,
      stdout,
      stderr,
    } = await captureStdio(() => main(['server', 'stop', '--json']))
    expect(exitCode).toBe(0)
    expect(stderr).toBe('')
    const parsed = JSON.parse(stdout)
    expect(parsed.ok).toBe(true)
    expect(parsed.action).toBe('stopped')
    expect(parsed.schemaVersion).toBe(1)
  })

  it('missing --json → exit 64, stdout empty, stderr contains usage hint', async () => {
    const { result: exitCode, stdout, stderr } = await captureStdio(() => main(['server', 'stop']))
    expect(exitCode).toBe(64)
    expect(stdout).toBe('')
    expect(stderr).toMatch(/--json/)
  })

  it('refused: stdout JSON with ok:false, exit 1', async () => {
    vi.mocked(stopModule.runServerStop).mockResolvedValueOnce({
      result: {
        schemaVersion: 1,
        ok: false,
        action: 'refused',
        reason: 'server-record-malformed',
        recordFound: true,
        recordFresh: false,
      },
      exitCode: 2,
    })
    const { result: exitCode, stdout } = await captureStdio(() =>
      main(['server', 'stop', '--json']),
    )
    expect(exitCode).toBe(2)
    const parsed = JSON.parse(stdout)
    expect(parsed.ok).toBe(false)
    expect(parsed.action).toBe('refused')
  })

  it('stdout is always a single JSON line with trailing newline', async () => {
    const { result: exitCode, stdout } = await captureStdio(() =>
      main(['server', 'stop', '--json']),
    )
    expect(exitCode).toBe(0)
    expect(stdout.endsWith('\n')).toBe(true)
    expect(stdout.trim().split('\n')).toHaveLength(1)
  })

  it('USAGE constant includes whiteboard server stop', () => {
    expect(USAGE).toMatch(/whiteboard server stop/)
  })
})

describe('CLI dispatcher: whiteboard server doctor', () => {
  it('success: stdout single JSON with ok/status/checks, stderr empty, exit 0', async () => {
    const {
      result: exitCode,
      stdout,
      stderr,
    } = await captureStdio(() =>
      main([
        'server',
        'doctor',
        '--json',
        '--external-url=https://whiteboard.example.com',
        '--auth-strategy=oauth-jwt',
        '--jwt-issuer=https://auth.example.com',
        '--jwt-audience=whiteboard',
        '--jwks-uri=https://auth.example.com/.well-known/jwks.json',
      ]),
    )
    expect(exitCode).toBe(0)
    expect(stderr).toBe('')
    const parsed = JSON.parse(stdout)
    expect(parsed.ok).toBe(true)
    expect(parsed.status).toBe('ok')
    expect(Array.isArray(parsed.checks)).toBe(true)
    expect(parsed.schemaVersion).toBe(1)
  })

  it('missing --json → exit 64, stdout empty, stderr contains usage hint', async () => {
    const {
      result: exitCode,
      stdout,
      stderr,
    } = await captureStdio(() => main(['server', 'doctor']))
    expect(exitCode).toBe(64)
    expect(stdout).toBe('')
    expect(stderr).toMatch(/--json/)
  })

  it('error result → exit 1, stdout contains JSON with ok:false', async () => {
    vi.mocked(doctorModule.runServerDoctor).mockResolvedValueOnce({
      result: {
        schemaVersion: 1,
        ok: false,
        status: 'error',
        checks: [{ id: 'server.config', status: 'error', summary: 'Server config is invalid' }],
      },
      exitCode: 1,
    })
    const { result: exitCode, stdout } = await captureStdio(() =>
      main([
        'server',
        'doctor',
        '--json',
        '--external-url=https://whiteboard.example.com',
        '--auth-strategy=oauth-jwt',
        '--jwt-issuer=https://auth.example.com',
        '--jwt-audience=whiteboard',
        '--jwks-uri=https://auth.example.com/.well-known/jwks.json',
      ]),
    )
    expect(exitCode).toBe(1)
    const parsed = JSON.parse(stdout)
    expect(parsed.ok).toBe(false)
    expect(parsed.status).toBe('error')
  })

  it('stdout is always a single JSON line with trailing newline', async () => {
    const { result: exitCode, stdout } = await captureStdio(() =>
      main([
        'server',
        'doctor',
        '--json',
        '--external-url=https://whiteboard.example.com',
        '--auth-strategy=oauth-jwt',
        '--jwt-issuer=https://auth.example.com',
        '--jwt-audience=whiteboard',
        '--jwks-uri=https://auth.example.com/.well-known/jwks.json',
      ]),
    )
    expect(exitCode).toBe(0)
    expect(stdout.endsWith('\n')).toBe(true)
    expect(stdout.trim().split('\n')).toHaveLength(1)
  })

  it('USAGE constant includes whiteboard server doctor', () => {
    expect(USAGE).toMatch(/whiteboard server doctor/)
  })
})
