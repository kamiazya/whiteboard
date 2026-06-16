/**
 * Verifies that the root secretlint config correctly:
 * - flags real absolute home-dir paths (/Users/<name>/... and /home/<name>/...)
 * - flags well-known secret patterns (e.g. AWS access key shape)
 * - does NOT flag angle-bracket placeholders like /Users/<user>/ used in docs
 * - does NOT flag the intentional non-secret dev token "whiteboard-dev"
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, it, expect } from 'vitest'

const REPO_ROOT = resolve(import.meta.dirname, '../../../')
const SECRETLINT_BIN = join(REPO_ROOT, 'node_modules', '.bin', 'secretlint')

/**
 * Run secretlint against `content` written to a temp file outside the repo.
 * Accepts an optional `binPath` override so tests can exercise the preflight
 * guard without modifying the filesystem.
 */
function runSecretlint(
  content: string,
  filename = 'test.md',
  binPath = SECRETLINT_BIN,
): { exitCode: number; output: string } {
  if (!existsSync(binPath)) {
    throw new Error(`secretlint binary not found at ${binPath} — run pnpm install`)
  }
  const dir = mkdtempSync(join(tmpdir(), 'secretlint-test-'))
  const filePath = join(dir, filename)
  writeFileSync(filePath, content, 'utf8')
  try {
    const output = execFileSync(
      binPath,
      [
        '--secretlintrc',
        join(REPO_ROOT, '.secretlintrc.json'),
        '--secretlintignore',
        join(REPO_ROOT, '.secretlintignore'),
        filePath,
      ],
      { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] },
    )
    return { exitCode: 0, output }
  } catch (err: unknown) {
    const e = err as { status?: number; stdout?: string; stderr?: string }
    return { exitCode: e.status ?? 1, output: (e.stdout ?? '') + (e.stderr ?? '') }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('runSecretlint preflight guard', () => {
  it('throws a descriptive error when the secretlint binary is absent', () => {
    // Passing a non-existent binPath exercises the guard without touching the
    // filesystem installation. The error message must be actionable (not a
    // raw ENOENT from execFileSync).
    expect(() =>
      runSecretlint('hello world', 'test.md', '/nonexistent/__secretlint_sentinel__'),
    ).toThrow(
      'secretlint binary not found at /nonexistent/__secretlint_sentinel__ — run pnpm install',
    )
  })
})

describe('secretlint config', () => {
  it('flags a real /Users/<name>/ absolute path (lowercase username)', () => {
    const result = runSecretlint('See /Users/alice/secret/path for details.')
    expect(result.exitCode, `expected non-zero exit, output: ${result.output}`).not.toBe(0)
  })

  it('flags a real /Users/<name>/ absolute path (uppercase-first username, e.g. macOS default)', () => {
    const result = runSecretlint('See /Users/Alice/secret/path for details.')
    expect(result.exitCode, `expected non-zero exit, output: ${result.output}`).not.toBe(0)
  })

  it('flags a real /home/<name>/ absolute path (lowercase username)', () => {
    const result = runSecretlint('export PATH=/home/bob/bin:$PATH')
    expect(result.exitCode, `expected non-zero exit, output: ${result.output}`).not.toBe(0)
  })

  it('flags a real /home/<name>/ absolute path (uppercase-first username, e.g. CI build users)', () => {
    const result = runSecretlint('export PATH=/home/BuildUser/bin:$PATH')
    expect(result.exitCode, `expected non-zero exit, output: ${result.output}`).not.toBe(0)
  })

  it('flags a well-known secret pattern (Slack bot token shape) from the recommend preset', () => {
    // Verifies the preset rule is wired up — if it were removed, this test would
    // fail before any home-dir rule could catch the regression. The token shape is
    // assembled at runtime (prefix + body) so this source file never contains a
    // literal Slack-token-shaped string, which would otherwise trip GitHub's
    // secret-scanning push protection on a deliberately-fake test fixture.
    const slackPrefix = `xo${'xb'}`
    const fakeSlackToken = `${slackPrefix}-1234567890-1234567890123-ABCDEFGHIJKLMNOPQRSTUVWX`
    const result = runSecretlint(`SLACK_TOKEN=${fakeSlackToken}`)
    expect(result.exitCode, `expected non-zero exit, output: ${result.output}`).not.toBe(0)
  })

  it('does NOT flag the angle-bracket placeholder /Users/<user>/', () => {
    const result = runSecretlint('Copy to /Users/<user>/Library/Application Support/')
    expect(result.exitCode, `expected zero exit (clean), output: ${result.output}`).toBe(0)
  })

  it('does NOT flag /home/<name>/ generic placeholder', () => {
    const result = runSecretlint('Default home is /home/<username>/projects')
    expect(result.exitCode, `expected zero exit (clean), output: ${result.output}`).toBe(0)
  })

  it('does NOT flag the intentional whiteboard-dev token in plain text', () => {
    // whiteboard-dev is a loopback-only dev token, not a recognizable secret pattern.
    const result = runSecretlint('token: whiteboard-dev')
    expect(result.exitCode, `expected zero exit (clean), output: ${result.output}`).toBe(0)
  })
})
