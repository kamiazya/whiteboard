import { describe, expect, it, vi } from 'vitest'

// Pin the runtime contract for `whiteboard server run` at the dispatcher boundary.
// Mocks server-run.js so tests don't need real env vars.

vi.mock('./server-run.js', () => ({
  runServerRun: vi.fn(async () => ({
    kind: 'dry-run-ok',
    result: {
      schemaVersion: 1,
      ok: true,
      dryRun: true,
      publicBaseUrl: 'https://whiteboard.example.com',
      allowedOrigins: ['https://whiteboard.example.com'],
      authStrategy: 'oauth-jwt',
    },
  })),
}))

const serverRunModule = await import('./server-run.js')
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

const VALID_FLAGS = [
  '--json',
  '--dry-run',
  '--external-url=https://whiteboard.example.com',
  '--auth-strategy=oauth-jwt',
  '--jwt-issuer=https://auth.example.com',
  '--jwt-audience=api',
  '--jwks-uri=https://auth.example.com/.well-known/jwks.json',
]

describe('CLI dispatcher: whiteboard server run', () => {
  it('dry-run success: stdout single JSON, stderr empty, exit 0', async () => {
    const {
      result: exitCode,
      stdout,
      stderr,
    } = await captureStdio(() => main(['server', 'run', ...VALID_FLAGS]))
    expect(exitCode).toBe(0)
    expect(stderr).toBe('')
    const parsed = JSON.parse(stdout)
    expect(parsed.ok).toBe(true)
    expect(parsed.dryRun).toBe(true)
    expect(parsed.schemaVersion).toBe(1)
  })

  it('missing --json → exit 64, stdout empty, stderr contains usage hint', async () => {
    const {
      result: exitCode,
      stdout,
      stderr,
    } = await captureStdio(() => main(['server', 'run', '--dry-run']))
    expect(exitCode).toBe(64)
    expect(stdout).toBe('')
    expect(stderr).toMatch(/--json/)
  })

  it('unknown server subcommand → exit 64, USAGE lists whiteboard server run', async () => {
    const {
      result: exitCode,
      stdout,
      stderr,
    } = await captureStdio(() => main(['server', 'bad-subcommand']))
    expect(exitCode).toBe(64)
    expect(stdout).toBe('')
    expect(stderr).toMatch(/whiteboard server run/)
  })

  it('server with no subcommand → exit 64', async () => {
    const { result: exitCode, stdout, stderr } = await captureStdio(() => main(['server']))
    expect(exitCode).toBe(64)
    expect(stdout).toBe('')
    expect(stderr).toMatch(/whiteboard server run/)
  })

  it('config-error: stdout empty, stderr generic safe message, exit 1', async () => {
    vi.mocked(serverRunModule.runServerRun).mockResolvedValueOnce({
      kind: 'config-error',
      code: 'server_mode_env.external_url_required',
      field: 'WHITEBOARD_SERVER_EXTERNAL_URL',
    })
    const {
      result: exitCode,
      stdout,
      stderr,
    } = await captureStdio(() => main(['server', 'run', ...VALID_FLAGS]))
    expect(exitCode).toBe(1)
    expect(stdout).toBe('')
    expect(stderr).toContain('server_mode_env.external_url_required')
    expect(stderr).toContain('WHITEBOARD_SERVER_EXTERNAL_URL')
    // No raw URL values should appear in stderr
    expect(stderr).not.toMatch(/https?:\/\//)
  })

  it('plan-error: stdout empty, stderr generic safe message, exit 1', async () => {
    vi.mocked(serverRunModule.runServerRun).mockResolvedValueOnce({
      kind: 'plan-error',
      code: 'server_mode.external_url_must_be_https',
    })
    const {
      result: exitCode,
      stdout,
      stderr,
    } = await captureStdio(() => main(['server', 'run', ...VALID_FLAGS]))
    expect(exitCode).toBe(1)
    expect(stdout).toBe('')
    expect(stderr).toContain('server_mode.external_url_must_be_https')
    expect(stderr).not.toMatch(/https?:\/\//)
  })

  it('start-error: stdout empty, stderr safe message, exit 1', async () => {
    vi.mocked(serverRunModule.runServerRun).mockResolvedValueOnce({
      kind: 'start-error',
    })
    const {
      result: exitCode,
      stdout,
      stderr,
    } = await captureStdio(() => main(['server', 'run', '--json']))
    expect(exitCode).toBe(1)
    expect(stdout).toBe('')
    expect(stderr).toMatch(/server failed to start/)
    // No raw paths, URLs, or tokens in stderr
    expect(stderr).not.toMatch(/https?:\/\//)
    expect(stderr).not.toMatch(/\/Users\/|\/tmp\/|\/private\//)
  })

  it('running: ready JSON written to stdout before never-resolving', async () => {
    const readyResult = {
      schemaVersion: 1 as const,
      ok: true as const,
      pid: process.pid,
      host: '0.0.0.0',
      port: 3099,
      publicBaseUrl: 'https://whiteboard.example.com',
      authStrategy: 'oauth-jwt' as const,
      startedAt: new Date().toISOString(),
    }
    vi.mocked(serverRunModule.runServerRun).mockResolvedValueOnce({
      kind: 'running',
      result: readyResult,
      close: async () => {},
    })

    let capturedStdout = ''
    const writeStdout = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      capturedStdout +=
        typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString('utf8')
      return true
    })
    // main() returns a never-resolving promise for 'running'; start it but don't await
    const runningPromise = main(['server', 'run', '--json'])
    // Yield to the microtask queue so writeJsonObject fires
    await new Promise<void>((r) => setImmediate(r))
    writeStdout.mockRestore()
    // Don't await runningPromise — it never resolves

    const parsed = JSON.parse(capturedStdout)
    expect(parsed.ok).toBe(true)
    expect(parsed.schemaVersion).toBe(1)
    expect(parsed.pid).toBe(process.pid)
    expect(parsed.publicBaseUrl).toBe('https://whiteboard.example.com')
    expect(parsed.authStrategy).toBe('oauth-jwt')
    // Prevent Jest/vitest from complaining about unhandled hanging promise
    void runningPromise
  })

  it('USAGE constant includes whiteboard server run --json', () => {
    expect(USAGE).toMatch(/whiteboard server run/)
    expect(USAGE).toMatch(/--json/)
  })

  it('local daemon commands unchanged: daemon status --json → still works', async () => {
    // Smoke: daemon routing guard not broken by server namespace addition.
    // We don't run the actual daemon status (no daemon.json) — just verify
    // the routing doesn't 404 to the unknown-command 64 path.
    const { result: exitCode } = await captureStdio(() => main(['daemon', 'status', '--json']))
    // 0 or non-zero is fine; 64 means routing broke
    expect(exitCode).not.toBe(64)
  })

  it('invalid arg: stdout empty on usage error', async () => {
    const { result: exitCode, stdout } = await captureStdio(() =>
      main(['server', 'run', '--json', '--unknown-arg=secret']),
    )
    expect(exitCode).toBe(64)
    expect(stdout).toBe('')
  })

  it('bare positional arg: stderr does not leak raw value', async () => {
    const {
      result: exitCode,
      stdout,
      stderr,
    } = await captureStdio(() => main(['server', 'run', '--json', 'secret-token-XYZ']))
    expect(exitCode).toBe(64)
    expect(stdout).toBe('')
    expect(stderr).not.toContain('secret-token-XYZ')
  })
})
