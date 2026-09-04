#!/usr/bin/env node
// `pnpm audit` behind a network-aware retry, for the CI `check` job and
// `pnpm check:local`.
//
// The audit exits 1 for two unrelated reasons. A vulnerability at/above the
// level is the gate doing its job and must fail IMMEDIATELY — a security
// gate that retries a finding is not a gate. The advisories endpoint dying
// is the npm registry's afternoon: pnpm's own three retries span four
// minutes, and on Sep 4 that was not enough — main went red on a stack
// trace with no finding in it, the second registry-shaped `check` failure
// in three days. This wrapper widens the horizon to roughly ten minutes
// across three attempts, which rides out the short registry incidents that
// caused both, and still fails — loudly, as a network failure — when the
// registry is genuinely down.
//
// Kept as a `pnpm audit:prod` script rather than shell in ci.yml:
// local-gate-command.test.ts derives the local gate from the `check` job's
// `pnpm `-prefixed run lines, so a bare-shell wrapper would silently drop
// the audit from the derived list.

import { spawnSync } from 'node:child_process'

/**
 * Only a failure the registry is known to produce earns a retry; anything
 * else — a finding, or a shape never seen before — fails immediately.
 * Fail-closed, because this wraps a security gate: novelty must not buy a
 * retry loop, and a finding preceded by a transient warning is still a
 * finding, which is why the findings signatures are checked FIRST.
 */
export function classifyAuditFailure(output) {
  if (/vulnerabilit(y|ies) found|│\s*(critical|high|moderate|low)\s*│/i.test(output)) {
    return 'findings'
  }
  const network =
    /TimeoutError|The operation was aborted due to timeout|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|socket hang up|fetch failed|registry\.npmjs\.org.*error/i
  return network.test(output) ? 'network' : 'findings'
}

const ATTEMPTS = 3
// Overridable so the retry path itself can be exercised against a dead
// registry without waiting three minutes for it.
const BACKOFF_MS = process.env.AUDIT_RETRY_BACKOFF_MS
  ? [0, ...process.env.AUDIT_RETRY_BACKOFF_MS.split(',').map(Number)]
  : [0, 60_000, 120_000]

async function main() {
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    if (BACKOFF_MS[attempt] > 0) {
      console.error(
        `[audit-with-retry] registry failure; retrying in ${BACKOFF_MS[attempt] / 1000}s (attempt ${attempt + 1} of ${ATTEMPTS})`,
      )
      await new Promise((resolve) => setTimeout(resolve, BACKOFF_MS[attempt]))
    }
    const result = spawnSync('pnpm', ['audit', '--prod', '--audit-level=high'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    process.stdout.write(result.stdout ?? '')
    process.stderr.write(result.stderr ?? '')
    if (result.status === 0) return
    if (classifyAuditFailure(`${result.stdout ?? ''}\n${result.stderr ?? ''}`) === 'findings') {
      process.exit(result.status ?? 1)
    }
  }
  console.error(
    '[audit-with-retry] the registry stayed unreachable across every attempt; failing rather than skipping a security gate',
  )
  process.exit(1)
}

// Import-safe: the classifier is unit-tested from mcp-server's release
// suite, and importing this module must not run an audit.
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  await main()
}
