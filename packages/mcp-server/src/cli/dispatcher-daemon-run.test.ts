import { describe, expect, it, vi } from 'vitest'
import { captureStdio } from '../shared/test-utils/capture-stdio.js'

// Pin the runtime contract for `whiteboard daemon run` at the dispatcher boundary.
// daemon-run.js is NOT imported for the argv-rejection tests since usage errors
// are returned before the dynamic import.

vi.mock('./daemon-run.js', () => ({
  runDaemonRun: vi.fn(async () => ({
    kind: 'refused',
    reason: 'fresh-daemon-already-running',
    message: 'already running',
    status: {},
  })),
}))

const { main } = await import('./dispatcher.js')

describe('whiteboard daemon run — --token= rejected at dispatch boundary', () => {
  it('--token=<value> returns exit 64 and does not echo the token value in stderr', async () => {
    const SECRET = 'dispatch-secret-token-XYZXYZ'
    const {
      result: exitCode,
      stdout,
      stderr,
    } = await captureStdio(() => main(['daemon', 'run', '--json', `--token=${SECRET}`]))
    expect(exitCode).toBe(64)
    expect(stdout).toBe('')
    expect(stderr).not.toContain(SECRET)
    expect(stderr).toMatch(/--token/)
  })

  it('--token <value> (space form) returns exit 64 and does not echo raw value in stderr', async () => {
    const SECRET = 'dispatch-space-secret-ABCABC'
    const {
      result: exitCode,
      stdout,
      stderr,
    } = await captureStdio(() => main(['daemon', 'run', '--json', '--token', SECRET]))
    expect(exitCode).toBe(64)
    expect(stdout).toBe('')
    expect(stderr).not.toContain(SECRET)
  })
})

describe('whiteboard daemon run — a daemon that stops on its own', () => {
  it('exits 0 and says why once the idle timeout closes it', async () => {
    const { runDaemonRun } = await import('./daemon-run.js')
    vi.mocked(runDaemonRun).mockResolvedValueOnce({
      kind: 'running',
      result: {
        schemaVersion: 1,
        ok: true,
        pid: 1,
        socketPath: '/tmp/wb/daemon.sock',
        version: '0.0.0',
        startedAt: '2026-09-27T00:00:00.000Z',
      },
      stopped: Promise.resolve('idle'),
    })
    const { result: exitCode, stderr } = await captureStdio(() =>
      main(['daemon', 'run', '--json', '--no-open']),
    )
    expect(exitCode).toBe(0)
    expect(stderr).toMatch(/idle/)
  })
})
