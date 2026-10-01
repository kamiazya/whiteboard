import { describe, expect, it, vi } from 'vitest'
import { captureStdio } from '../shared/test-utils/capture-stdio.js'

vi.mock('./server-support-bundle.js', () => ({
  runServerSupportBundle: vi.fn(async () => ({
    stdout:
      '{"schemaVersion":1,"ok":true,"operation":"support-bundle","files":["status.json","doctor.json","record.json","manifest.json"]}\n',
    stderr: '',
    exitCode: 0,
  })),
}))

const bundleModule = await import('./server-support-bundle.js')
const { main, USAGE } = await import('./dispatcher.js')

describe('CLI dispatcher: whiteboard server support-bundle', () => {
  it('success: stdout single JSON object, stderr empty, exit 0', async () => {
    const {
      result: exitCode,
      stdout,
      stderr,
    } = await captureStdio(() =>
      main(['server', 'support-bundle', '--json', '--output-dir=/tmp/out']),
    )
    expect(exitCode).toBe(0)
    expect(stderr).toBe('')
    expect(stdout.endsWith('\n')).toBe(true)
    const parsed = JSON.parse(stdout)
    expect(parsed.ok).toBe(true)
    expect(parsed.operation).toBe('support-bundle')
    expect(parsed.schemaVersion).toBe(1)
    expect(Array.isArray(parsed.files)).toBe(true)
  })

  it('failure: runServerSupportBundle returns exit 1 → exit 1, stderr generic copy', async () => {
    vi.mocked(bundleModule.runServerSupportBundle).mockResolvedValueOnce({
      stdout: '',
      stderr: 'Could not write support bundle. The output directory must be empty.\n',
      exitCode: 1,
    })
    const {
      result: exitCode,
      stdout,
      stderr,
    } = await captureStdio(() =>
      main(['server', 'support-bundle', '--json', '--output-dir=/tmp/out']),
    )
    expect(exitCode).toBe(1)
    expect(stdout).toBe('')
    expect(stderr).toMatch(/output directory must be empty/i)
  })

  it('missing --json → exit 64, stdout empty, stderr contains usage hint', async () => {
    const {
      result: exitCode,
      stdout,
      stderr,
    } = await captureStdio(() => main(['server', 'support-bundle', '--output-dir=/tmp/out']))
    expect(exitCode).toBe(64)
    expect(stdout).toBe('')
    expect(stderr).toMatch(/--json/)
  })

  it('missing --output-dir → exit 64, stdout empty', async () => {
    const { result: exitCode, stdout } = await captureStdio(() =>
      main(['server', 'support-bundle', '--json']),
    )
    expect(exitCode).toBe(64)
    expect(stdout).toBe('')
  })

  it('stdout is always a single JSON line with trailing newline on success', async () => {
    const { result: exitCode, stdout } = await captureStdio(() =>
      main(['server', 'support-bundle', '--json', '--output-dir=/tmp/out']),
    )
    expect(exitCode).toBe(0)
    expect(stdout.endsWith('\n')).toBe(true)
    expect(stdout.trim().split('\n')).toHaveLength(1)
  })

  it('USAGE constant includes whiteboard server support-bundle', () => {
    expect(USAGE).toMatch(/whiteboard server support-bundle/)
  })

  it('unknown server subcommand still exits 64 and USAGE lists support-bundle', async () => {
    const {
      result: exitCode,
      stdout,
      stderr,
    } = await captureStdio(() => main(['server', 'not-a-real-subcommand', '--json']))
    expect(exitCode).toBe(64)
    expect(stdout).toBe('')
    expect(stderr).toMatch(/server support-bundle/)
  })
})
