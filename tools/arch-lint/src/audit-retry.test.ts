// `pnpm audit` exits 1 for two unrelated reasons, and CI must not treat them
// alike: a vulnerability at/above the level is the gate doing its job, while
// the advisories endpoint timing out is the npm registry's afternoon. Two of
// the last three red `check` jobs on main were the second kind — pnpm's own
// three retries spent four minutes against a dead endpoint and the job
// failed with a stack trace instead of a finding.
//
// The classifier is pure and lives beside the runner in
// tools/checks/src/audit-with-retry.mjs; these fixtures are the two real
// outputs those jobs produced, abbreviated to their signatures.
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { REPO_ROOT } from './scan-roots.js'

const ROOT = REPO_ROOT
const SCRIPT = join(ROOT, 'tools/checks/src/audit-with-retry.mjs')

const { classifyAuditFailure } = (await import(pathToFileURL(SCRIPT).href)) as {
  classifyAuditFailure: (output: string) => 'network' | 'findings'
}

/** The Sep 4 main failure, verbatim signature (run 33822259235). */
const REGISTRY_TIMEOUT = [
  '[WARN] POST https://registry.npmjs.org/-/npm/v1/security/advisories/bulk error (23). Will retry in 10 seconds. 2 retries left.',
  '[23] The operation was aborted due to timeout',
  'TimeoutError: The operation was aborted due to timeout',
  '    at new DOMException (node:internal/per_context/domexception:76:18)',
].join('\n')

/** The Sep 2 main failure: a real finding (fast-uri, since overridden). */
const REAL_FINDING = [
  '┌─────────────────────┬────────────────────────┐',
  '│ high                │ fast-uri vulnerable to host confusion  │',
  '│ Package             │ fast-uri               │',
  '│ Vulnerable versions │ >=3.1.3 <3.1.6         │',
  '└─────────────────────┴────────────────────────┘',
  '1 vulnerabilities found',
  'Severity: 1 high',
].join('\n')

describe('classifyAuditFailure', () => {
  it('reads the Sep-4 registry timeout as network, so it is retried', () => {
    expect(classifyAuditFailure(REGISTRY_TIMEOUT)).toBe('network')
  })

  it('reads the Sep-2 fast-uri finding as findings, so it fails immediately', () => {
    expect(classifyAuditFailure(REAL_FINDING)).toBe('findings')
  })

  it('reads a finding as findings even when a transient warning precedes it', () => {
    // One retry succeeding and then reporting a CVE is a finding, not a
    // network failure — the warning must not win over the table.
    expect(classifyAuditFailure(`${REGISTRY_TIMEOUT.split('\n')[0]}\n${REAL_FINDING}`)).toBe(
      'findings',
    )
  })

  it('defaults an unrecognized failure to findings, so novelty cannot buy a retry loop', () => {
    // Fail-closed: this wraps a security gate. An output matching neither
    // signature is treated as a real failure — three identical retries of a
    // genuinely broken invocation cost minutes and mask the message; a
    // vulnerability retried as if it were weather would be worse.
    expect(classifyAuditFailure('something entirely new went wrong')).toBe('findings')
  })

  it('treats ECONNRESET and EAI_AGAIN as network, the other spellings the registry dies with', () => {
    expect(classifyAuditFailure('FetchError: request failed, reason: read ECONNRESET')).toBe(
      'network',
    )
    expect(classifyAuditFailure('getaddrinfo EAI_AGAIN registry.npmjs.org')).toBe('network')
  })
})

// `pnpm audit:prod` runs the file as a process, so its entry guard, its
// retry loop and the offline escape are only reached that way. A `pnpm` on
// PATH stands in for the real audit, answering each call from a script and
// recording the arguments it was given.
describe('audit-with-retry as `pnpm audit:prod` runs it', () => {
  const workDir = mkdtempSync(join(tmpdir(), 'audit-with-retry-'))
  afterAll(() => rmSync(workDir, { recursive: true, force: true }))
  let runCount = 0

  function run(answers: { status: number; out: string }[], env: Record<string, string> = {}) {
    runCount += 1
    const binDir = join(workDir, `bin-${runCount}`)
    mkdirSync(binDir)
    const callLog = join(binDir, 'calls.jsonl')
    writeFileSync(callLog, '')
    writeFileSync(
      join(binDir, 'pnpm'),
      `#!${process.execPath}
const fs = require('node:fs')
const log = ${JSON.stringify(callLog)}
const n = fs.readFileSync(log, 'utf8').split('\\n').filter(Boolean).length
fs.appendFileSync(log, JSON.stringify(process.argv.slice(2)) + '\\n')
const answers = ${JSON.stringify(answers)}
const answer = answers[Math.min(n, answers.length - 1)]
process.stdout.write(answer.out)
process.exit(answer.status)
`,
    )
    chmodSync(join(binDir, 'pnpm'), 0o755)
    const r = spawnSync(process.execPath, [SCRIPT], {
      cwd: workDir,
      encoding: 'utf8',
      timeout: 30_000,
      env: {
        PATH: `${binDir}:${process.env.PATH ?? ''}`,
        AUDIT_RETRY_BACKOFF_MS: '1,1',
        ...env,
      },
    })
    const calls = readFileSync(callLog, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as string[])
    return { status: r.status, stdout: r.stdout, stderr: r.stderr, calls }
  }

  const CLEAN = { status: 0, out: 'No known vulnerabilities found\n' }
  const FINDING = { status: 1, out: '1 vulnerabilities found\nSeverity: 1 high\n' }
  const REGISTRY_DOWN = { status: 1, out: 'request to registry.npmjs.org failed: ECONNRESET\n' }

  it('runs the prod audit once and passes on a clean answer', () => {
    const r = run([CLEAN])
    expect(r.status).toBe(0)
    expect(r.calls).toEqual([['audit', '--prod', '--audit-level=high']])
    expect(r.stdout).toContain('No known vulnerabilities found')
  })

  it('fails at once on a finding, without retrying', () => {
    const r = run([FINDING, CLEAN])
    expect(r.status).toBe(1)
    expect(r.calls).toHaveLength(1)
  })

  it('retries a registry failure and passes when the registry recovers', () => {
    const r = run([REGISTRY_DOWN, CLEAN])
    expect(r.status).toBe(0)
    expect(r.calls).toHaveLength(2)
    expect(r.stderr).toContain('registry failure; retrying in 0.001s (attempt 2 of 3)')
  })

  it('fails on a finding that follows a registry failure', () => {
    const r = run([REGISTRY_DOWN, FINDING, CLEAN])
    expect(r.status).toBe(1)
    expect(r.calls).toHaveLength(2)
  })

  it('gives up after three attempts, failing rather than skipping', () => {
    const r = run([REGISTRY_DOWN])
    expect(r.status).toBe(1)
    expect(r.calls).toHaveLength(3)
    expect(r.stderr).toContain('the registry stayed unreachable across every attempt')
  })

  it('skips loudly, without running the audit, when WHITEBOARD_SKIP_AUDIT=1', () => {
    const r = run([FINDING], { WHITEBOARD_SKIP_AUDIT: '1' })
    expect(r.status).toBe(0)
    expect(r.calls).toEqual([])
    expect(r.stderr).toContain('the prod audit was SKIPPED, not passed')
  })

  it('runs the audit for any other WHITEBOARD_SKIP_AUDIT value', () => {
    const r = run([FINDING], { WHITEBOARD_SKIP_AUDIT: 'true' })
    expect(r.status).toBe(1)
    expect(r.calls).toHaveLength(1)
    expect(r.stderr).not.toContain('SKIPPED')
  })
})
