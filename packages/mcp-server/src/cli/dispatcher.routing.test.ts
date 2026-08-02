import { describe, expect, it, vi } from 'vitest'

// Routing-only coverage for dispatcher.ts.
// Each mock returns the minimal shape needed to exercise the routing
// branch and assert exit code. Handler behavior is tested elsewhere.

vi.mock('../server/mcp/index.js', () => ({
  main: vi.fn(async () => undefined),
}))

vi.mock('./daemon-status.js', () => ({
  runDaemonStatus: vi.fn(async () => ({ result: { schemaVersion: 1, ok: true }, exitCode: 0 })),
}))

vi.mock('./daemon-doctor.js', () => ({
  runDaemonDoctor: vi.fn(async () => ({ result: { schemaVersion: 1, ok: true }, exitCode: 0 })),
}))

vi.mock('./daemon-stop.js', () => ({
  runDaemonStop: vi.fn(async () => ({ result: { schemaVersion: 1, ok: true }, exitCode: 0 })),
}))

vi.mock('./daemon-logs.js', () => ({
  runDaemonLogs: vi.fn(async () => ({ stdout: '{"level":"info"}\n', stderr: '', exitCode: 0 })),
}))

vi.mock('./daemon-support-bundle.js', () => ({
  runDaemonSupportBundle: vi.fn(async () => ({ stdout: '{"ok":true}\n', stderr: '', exitCode: 0 })),
}))

vi.mock('./daemon-run.js', () => ({
  runDaemonRun: vi.fn(async () => ({
    kind: 'refused',
    reason: 'fresh-daemon-already-running',
    message: 'already running',
    status: {},
  })),
}))

vi.mock('./server-status.js', () => ({
  runServerStatus: vi.fn(async () => ({ result: { schemaVersion: 1, ok: true }, exitCode: 0 })),
}))

vi.mock('./server-stop.js', () => ({
  runServerStop: vi.fn(async () => ({ result: { schemaVersion: 1, ok: true }, exitCode: 0 })),
}))

vi.mock('./server-doctor.js', () => ({
  runServerDoctor: vi.fn(async () => ({ result: { schemaVersion: 1, ok: true }, exitCode: 0 })),
}))

vi.mock('./server-run.js', () => ({
  runServerRun: vi.fn(async () => ({
    kind: 'dry-run-ok',
    result: { schemaVersion: 1, ok: true },
  })),
}))

vi.mock('./server-backup.js', () => ({
  runServerBackup: vi.fn(async () => ({
    kind: 'ok',
    result: { schemaVersion: 1, ok: true, backupDir: '/tmp/backup' },
  })),
}))

vi.mock('./server-restore.js', () => ({
  runServerRestore: vi.fn(async () => ({
    kind: 'ok',
    result: { schemaVersion: 1, ok: true },
  })),
}))

vi.mock('./server-support-bundle.js', () => ({
  runServerSupportBundle: vi.fn(async () => ({ stdout: '{"ok":true}\n', stderr: '', exitCode: 0 })),
}))

// Import modules after mocks are installed.
const mcpModule = await import('../server/mcp/index.js')
const daemonStatusModule = await import('./daemon-status.js')
const daemonDoctorModule = await import('./daemon-doctor.js')
const daemonStopModule = await import('./daemon-stop.js')
const daemonLogsModule = await import('./daemon-logs.js')
const daemonSupportBundleModule = await import('./daemon-support-bundle.js')
const daemonRunModule = await import('./daemon-run.js')
const serverStatusModule = await import('./server-status.js')
const serverStopModule = await import('./server-stop.js')
const serverDoctorModule = await import('./server-doctor.js')
const serverRunModule = await import('./server-run.js')
const serverBackupModule = await import('./server-backup.js')
const serverRestoreModule = await import('./server-restore.js')
const serverSupportBundleModule = await import('./server-support-bundle.js')
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

// MCP dispatch never resolves on the happy path (StdioServerTransport keeps the
// process alive), so MCP-path tests fire-and-forget `main` and yield one timer
// tick to let the synchronous routing branch reach the handler.
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 20))
}

// ---------------------------------------------------------------------------
// no-arg → MCP stdio path
// ---------------------------------------------------------------------------
describe('dispatcher routing: no-arg → MCP stdio', () => {
  it('invokes the MCP handler when argv is empty', async () => {
    vi.mocked(mcpModule.main).mockClear()
    void main([])
    await tick()
    expect(vi.mocked(mcpModule.main)).toHaveBeenCalledOnce()
  })
})

// ---------------------------------------------------------------------------
// `mcp` explicit subcommand
// ---------------------------------------------------------------------------
describe('dispatcher routing: whiteboard mcp', () => {
  it('invokes the MCP handler for `mcp` with no further args', async () => {
    vi.mocked(mcpModule.main).mockClear()
    void main(['mcp'])
    await tick()
    expect(vi.mocked(mcpModule.main)).toHaveBeenCalledOnce()
  })

  it('USAGE includes `whiteboard mcp`', () => {
    expect(USAGE).toMatch(/whiteboard mcp/)
  })
})

// ---------------------------------------------------------------------------
// daemon subcommands
// ---------------------------------------------------------------------------
describe('dispatcher routing: whiteboard daemon status', () => {
  it('routes to runDaemonStatus and exits 0', async () => {
    vi.mocked(daemonStatusModule.runDaemonStatus).mockClear()
    const { result: exitCode } = await captureStdio(() => main(['daemon', 'status', '--json']))
    expect(exitCode).toBe(0)
    expect(vi.mocked(daemonStatusModule.runDaemonStatus)).toHaveBeenCalledOnce()
  })

  it('USAGE includes `whiteboard daemon status`', () => {
    expect(USAGE).toMatch(/whiteboard daemon status/)
  })
})

describe('dispatcher routing: whiteboard daemon doctor', () => {
  it('routes to runDaemonDoctor and exits 0', async () => {
    vi.mocked(daemonDoctorModule.runDaemonDoctor).mockClear()
    const { result: exitCode } = await captureStdio(() => main(['daemon', 'doctor', '--json']))
    expect(exitCode).toBe(0)
    expect(vi.mocked(daemonDoctorModule.runDaemonDoctor)).toHaveBeenCalledOnce()
  })

  it('USAGE includes `whiteboard daemon doctor`', () => {
    expect(USAGE).toMatch(/whiteboard daemon doctor/)
  })
})

describe('dispatcher routing: whiteboard daemon stop', () => {
  it('routes to runDaemonStop and exits 0', async () => {
    vi.mocked(daemonStopModule.runDaemonStop).mockClear()
    const { result: exitCode } = await captureStdio(() => main(['daemon', 'stop', '--json']))
    expect(exitCode).toBe(0)
    expect(vi.mocked(daemonStopModule.runDaemonStop)).toHaveBeenCalledOnce()
  })

  it('USAGE includes `whiteboard daemon stop`', () => {
    expect(USAGE).toMatch(/whiteboard daemon stop/)
  })
})

describe('dispatcher routing: whiteboard daemon logs', () => {
  it('routes to runDaemonLogs and exits 0', async () => {
    vi.mocked(daemonLogsModule.runDaemonLogs).mockClear()
    const { result: exitCode } = await captureStdio(() => main(['daemon', 'logs', '--json']))
    expect(exitCode).toBe(0)
    expect(vi.mocked(daemonLogsModule.runDaemonLogs)).toHaveBeenCalledOnce()
  })

  it('USAGE includes `whiteboard daemon logs`', () => {
    expect(USAGE).toMatch(/whiteboard daemon logs/)
  })
})

describe('dispatcher routing: whiteboard daemon support-bundle', () => {
  it('routes to runDaemonSupportBundle and exits 0', async () => {
    vi.mocked(daemonSupportBundleModule.runDaemonSupportBundle).mockClear()
    const { result: exitCode } = await captureStdio(() =>
      main(['daemon', 'support-bundle', '--json', '--output-dir=/tmp/out']),
    )
    expect(exitCode).toBe(0)
    expect(vi.mocked(daemonSupportBundleModule.runDaemonSupportBundle)).toHaveBeenCalledOnce()
  })

  it('USAGE includes `whiteboard daemon support-bundle`', () => {
    expect(USAGE).toMatch(/whiteboard daemon support-bundle/)
  })
})

describe('dispatcher routing: whiteboard daemon run', () => {
  it('routes to runDaemonRun (refused case exits 1)', async () => {
    vi.mocked(daemonRunModule.runDaemonRun).mockClear()
    const { result: exitCode, stderr } = await captureStdio(() => main(['daemon', 'run', '--json']))
    // runDaemonRun mock returns `refused` → exit 1
    expect(exitCode).toBe(1)
    expect(stderr).toMatch(/already running/)
    expect(vi.mocked(daemonRunModule.runDaemonRun)).toHaveBeenCalledOnce()
  })

  it('USAGE includes `whiteboard daemon run`', () => {
    expect(USAGE).toMatch(/whiteboard daemon run/)
  })
})

// ---------------------------------------------------------------------------
// server subcommands
// ---------------------------------------------------------------------------
describe('dispatcher routing: whiteboard server status', () => {
  it('routes to runServerStatus and exits 0', async () => {
    vi.mocked(serverStatusModule.runServerStatus).mockClear()
    const { result: exitCode } = await captureStdio(() => main(['server', 'status', '--json']))
    expect(exitCode).toBe(0)
    expect(vi.mocked(serverStatusModule.runServerStatus)).toHaveBeenCalledOnce()
  })

  it('USAGE includes `whiteboard server status`', () => {
    expect(USAGE).toMatch(/whiteboard server status/)
  })
})

describe('dispatcher routing: whiteboard server doctor', () => {
  it('routes to runServerDoctor and exits 0', async () => {
    vi.mocked(serverDoctorModule.runServerDoctor).mockClear()
    const { result: exitCode } = await captureStdio(() =>
      main([
        'server',
        'doctor',
        '--json',
        '--external-url=https://w.example.com',
        '--auth-strategy=oauth-jwt',
        '--jwt-issuer=https://auth.example.com',
        '--jwt-audience=wb',
        '--jwks-uri=https://auth.example.com/.well-known/jwks.json',
      ]),
    )
    expect(exitCode).toBe(0)
    expect(vi.mocked(serverDoctorModule.runServerDoctor)).toHaveBeenCalledOnce()
  })

  it('USAGE includes `whiteboard server doctor`', () => {
    expect(USAGE).toMatch(/whiteboard server doctor/)
  })
})

describe('dispatcher routing: whiteboard server stop', () => {
  it('routes to runServerStop and exits 0', async () => {
    vi.mocked(serverStopModule.runServerStop).mockClear()
    const { result: exitCode } = await captureStdio(() => main(['server', 'stop', '--json']))
    expect(exitCode).toBe(0)
    expect(vi.mocked(serverStopModule.runServerStop)).toHaveBeenCalledOnce()
  })

  it('USAGE includes `whiteboard server stop`', () => {
    expect(USAGE).toMatch(/whiteboard server stop/)
  })
})

describe('dispatcher routing: whiteboard server run', () => {
  it('routes to runServerRun (dry-run-ok exits 0)', async () => {
    vi.mocked(serverRunModule.runServerRun).mockClear()
    const { result: exitCode } = await captureStdio(() =>
      main(['server', 'run', '--json', '--dry-run']),
    )
    expect(exitCode).toBe(0)
    expect(vi.mocked(serverRunModule.runServerRun)).toHaveBeenCalledOnce()
  })

  it('USAGE includes `whiteboard server run`', () => {
    expect(USAGE).toMatch(/whiteboard server run/)
  })
})

describe('dispatcher routing: whiteboard server backup', () => {
  it('routes to runServerBackup and exits 0', async () => {
    vi.mocked(serverBackupModule.runServerBackup).mockClear()
    const { result: exitCode } = await captureStdio(() =>
      main(['server', 'backup', '--json', '--output-dir=/tmp/backup-out']),
    )
    expect(exitCode).toBe(0)
    expect(vi.mocked(serverBackupModule.runServerBackup)).toHaveBeenCalledOnce()
  })

  it('exits 1 and writes to stderr when server is running', async () => {
    vi.mocked(serverBackupModule.runServerBackup).mockResolvedValueOnce({
      kind: 'running-server',
    })
    const { result: exitCode, stderr } = await captureStdio(() =>
      main(['server', 'backup', '--json', '--output-dir=/tmp/backup-out']),
    )
    expect(exitCode).toBe(1)
    expect(stderr).toMatch(/backup refused: server is running/)
  })

  it('exits 1 and writes to stderr when output path is invalid', async () => {
    vi.mocked(serverBackupModule.runServerBackup).mockResolvedValueOnce({
      kind: 'invalid-output-path',
    })
    const { result: exitCode, stderr } = await captureStdio(() =>
      main(['server', 'backup', '--json', '--output-dir=/tmp/backup-out']),
    )
    expect(exitCode).toBe(1)
    expect(stderr).toMatch(/backup refused: output path is not an empty directory/)
  })

  it('exits 1 and writes to stderr on error outcome', async () => {
    vi.mocked(serverBackupModule.runServerBackup).mockResolvedValueOnce({
      kind: 'error',
    })
    const { result: exitCode, stderr } = await captureStdio(() =>
      main(['server', 'backup', '--json', '--output-dir=/tmp/backup-out']),
    )
    expect(exitCode).toBe(1)
    expect(stderr).toMatch(/backup failed/)
  })

  it('USAGE includes `whiteboard server backup`', () => {
    expect(USAGE).toMatch(/whiteboard server backup/)
  })
})

describe('dispatcher routing: whiteboard server restore', () => {
  it('routes to runServerRestore and exits 0', async () => {
    vi.mocked(serverRestoreModule.runServerRestore).mockClear()
    const { result: exitCode } = await captureStdio(() =>
      main(['server', 'restore', '--json', '--backup-dir=/tmp/bk', '--target-dir=/tmp/tg']),
    )
    expect(exitCode).toBe(0)
    expect(vi.mocked(serverRestoreModule.runServerRestore)).toHaveBeenCalledOnce()
  })

  it('USAGE includes `whiteboard server restore`', () => {
    expect(USAGE).toMatch(/whiteboard server restore/)
  })
})

describe('dispatcher routing: whiteboard server support-bundle', () => {
  it('routes to runServerSupportBundle and exits 0', async () => {
    vi.mocked(serverSupportBundleModule.runServerSupportBundle).mockClear()
    const { result: exitCode } = await captureStdio(() =>
      main(['server', 'support-bundle', '--json', '--output-dir=/tmp/sb-out']),
    )
    expect(exitCode).toBe(0)
    expect(vi.mocked(serverSupportBundleModule.runServerSupportBundle)).toHaveBeenCalledOnce()
  })

  it('USAGE includes `whiteboard server support-bundle`', () => {
    expect(USAGE).toMatch(/whiteboard server support-bundle/)
  })
})

// ---------------------------------------------------------------------------
// Unknown commands → exit 64 + USAGE in stderr
// ---------------------------------------------------------------------------
describe('dispatcher routing: unknown top-level command', () => {
  it('returns exit 64 for an unrecognized command', async () => {
    const { result: exitCode, stdout, stderr } = await captureStdio(() => main(['bogus-command']))
    expect(exitCode).toBe(64)
    expect(stdout).toBe('')
    expect(stderr).toMatch(/Unknown command/)
  })

  it('stderr lists all recognized commands', async () => {
    const { stderr } = await captureStdio(() => main(['bogus-command']))
    // USAGE is echoed to stderr; spot-check key commands are present
    expect(stderr).toMatch(/whiteboard mcp/)
    expect(stderr).toMatch(/whiteboard daemon/)
    expect(stderr).toMatch(/whiteboard server/)
  })
})

describe('dispatcher routing: unknown daemon subcommand', () => {
  it('returns exit 64 for an unknown daemon subcommand', async () => {
    const {
      result: exitCode,
      stdout,
      stderr,
    } = await captureStdio(() => main(['daemon', 'bogus-subcommand']))
    expect(exitCode).toBe(64)
    expect(stdout).toBe('')
    expect(stderr).toMatch(/Unknown command/)
  })
})

describe('dispatcher routing: unknown server subcommand', () => {
  it('returns exit 64 for an unknown server subcommand', async () => {
    const {
      result: exitCode,
      stdout,
      stderr,
    } = await captureStdio(() => main(['server', 'bogus-subcommand']))
    expect(exitCode).toBe(64)
    expect(stdout).toBe('')
    expect(stderr).toMatch(/Unknown server subcommand/)
  })
})

// ---------------------------------------------------------------------------
// --version / -v → print version and exit 0
// ---------------------------------------------------------------------------
describe('dispatcher routing: --version flag', () => {
  it('returns exit 0 for --version', async () => {
    const { result: exitCode } = await captureStdio(() => main(['--version']))
    expect(exitCode).toBe(0)
  })

  it('prints only a bare semver line to stdout for --version', async () => {
    const { stdout } = await captureStdio(() => main(['--version']))
    expect(stdout).toMatch(/^\d+\.\d+\.\d+\n$/)
  })

  it('writes nothing to stderr for --version', async () => {
    const { stderr } = await captureStdio(() => main(['--version']))
    expect(stderr).toBe('')
  })

  it('returns exit 0 for -v', async () => {
    const { result: exitCode } = await captureStdio(() => main(['-v']))
    expect(exitCode).toBe(0)
  })

  it('prints only a bare semver line to stdout for -v', async () => {
    const { stdout } = await captureStdio(() => main(['-v']))
    expect(stdout).toMatch(/^\d+\.\d+\.\d+\n$/)
  })

  it('writes nothing to stderr for -v', async () => {
    const { stderr } = await captureStdio(() => main(['-v']))
    expect(stderr).toBe('')
  })

  it('returns exit 0 for --version in mid-position (e.g. daemon --version)', async () => {
    const { result: exitCode, stdout } = await captureStdio(() => main(['daemon', '--version']))
    expect(exitCode).toBe(0)
    expect(stdout).toMatch(/^\d+\.\d+\.\d+\n$/)
  })

  it('writes nothing to stderr for --version in mid-position', async () => {
    const { stderr } = await captureStdio(() => main(['daemon', '--version']))
    expect(stderr).toBe('')
  })

  it('returns exit 0 for -v in mid-position (e.g. server -v)', async () => {
    const { result: exitCode, stdout } = await captureStdio(() => main(['server', '-v']))
    expect(exitCode).toBe(0)
    expect(stdout).toMatch(/^\d+\.\d+\.\d+\n$/)
  })

  it('writes nothing to stderr for -v in mid-position', async () => {
    const { stderr } = await captureStdio(() => main(['server', '-v']))
    expect(stderr).toBe('')
  })

  it('USAGE documents --version / -v', () => {
    expect(USAGE).toMatch(/--version/)
    // Pin the short alias too — without this, dropping `-v` from USAGE would
    // silently pass even though the runtime alias keeps working.
    expect(USAGE).toMatch(/-v\b/)
  })
})

// ---------------------------------------------------------------------------
// `whiteboard trust` was removed along with the rest of the silent-reconnect
// surface — it now routes to the unknown-command path like any other typo.
// ---------------------------------------------------------------------------
describe('dispatcher routing: whiteboard trust (removed)', () => {
  it('routes `trust list` to the unknown-command usage output, not a special-cased command', async () => {
    const { result: exitCode, stdout, stderr } = await captureStdio(() => main(['trust', 'list']))
    expect(exitCode).toBe(64)
    expect(stdout).toBe('')
    expect(stderr).toContain('Unknown command')
  })

  it('USAGE no longer advertises a trust subcommand', () => {
    expect(USAGE).not.toMatch(/\btrust\b/)
  })
})
