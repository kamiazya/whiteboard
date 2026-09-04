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
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../../..')

const { classifyAuditFailure } = (await import(
  pathToFileURL(join(ROOT, 'tools/checks/src/audit-with-retry.mjs')).href
)) as { classifyAuditFailure: (output: string) => 'network' | 'findings' }

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
