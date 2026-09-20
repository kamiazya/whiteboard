import { replicaTierSchema } from '@kamiazya/whiteboard-daemon-client/api-contracts/replica-key'
import type { EnvIssue, ParsedSetting } from '../shared/env-setting.js'
import { parseOptionalMilliseconds } from '../shared/env-setting.js'

/**
 * The read plane's process-level settings (ADR-0042 decisions 1/3/5), held
 * to the rule in `shared/env-setting.ts`: an unset setting takes its
 * default, a setting that is present and cannot be understood aborts
 * startup.
 */

const REPLICA_TIER_ENV = 'WHITEBOARD_REPLICA_TIER'
const REPLICA_LEASE_TTL_ENV = 'WHITEBOARD_REPLICA_LEASE_TTL_MS'

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000

/** What a workspace with no per-workspace `replicaTier` override gets. */
export function parseReplicaTier(
  env: NodeJS.ProcessEnv = process.env,
): ParsedSetting<'no-offline' | 'offline' | 'bounded'> {
  const trimmed = env[REPLICA_TIER_ENV]?.trim()
  if (trimmed === undefined || trimmed === '') return { ok: true, value: 'offline' }
  const parsed = replicaTierSchema.safeParse(trimmed)
  if (!parsed.success) {
    return { ok: false, reason: "must be one of: 'no-offline', 'offline', 'bounded'" }
  }
  return { ok: true, value: parsed.data }
}

/** How long a `bounded`-tier lease lasts before the browser must discard the
 *  key. Default 7 days. */
export function parseReplicaLeaseTtlMs(
  env: NodeJS.ProcessEnv = process.env,
): ParsedSetting<number> {
  const parsed = parseOptionalMilliseconds(env[REPLICA_LEASE_TTL_ENV], SEVEN_DAYS_MS)
  if (!parsed.ok) return parsed
  // fallback is a number, never null, so a successful parse always carries one.
  return { ok: true, value: parsed.value as number }
}

export interface ReplicaEnv {
  tier: 'no-offline' | 'offline' | 'bounded'
  leaseTtlMs: number
}

/** Read once at startup and threaded through — see server/index.ts's
 *  `main()`, never re-read process.env inside a route. */
export function resolveReplicaEnv(env: NodeJS.ProcessEnv = process.env): ReplicaEnv {
  const tier = parseReplicaTier(env)
  const leaseTtlMs = parseReplicaLeaseTtlMs(env)
  return {
    tier: tier.ok ? tier.value : 'offline',
    leaseTtlMs: leaseTtlMs.ok ? leaseTtlMs.value : SEVEN_DAYS_MS,
  }
}

/** Every setting this family cannot honour, in one pass — composed into
 *  `startup-env.ts`'s `collectStartupEnvIssues`. */
export function collectReplicaEnvIssues(env: NodeJS.ProcessEnv = process.env): EnvIssue[] {
  const issues: EnvIssue[] = []
  const tier = parseReplicaTier(env)
  if (!tier.ok) issues.push({ variable: REPLICA_TIER_ENV, reason: tier.reason })
  const leaseTtlMs = parseReplicaLeaseTtlMs(env)
  if (!leaseTtlMs.ok) issues.push({ variable: REPLICA_LEASE_TTL_ENV, reason: leaseTtlMs.reason })
  return issues
}
