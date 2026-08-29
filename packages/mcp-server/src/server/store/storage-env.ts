import type { EnvIssue, ParsedSetting } from '../../shared/env-setting.js'
import { parseOptionalMilliseconds } from '../../shared/env-setting.js'
import { DB_URL_ENV, resolveDatabaseLocation } from './db/location.js'

/**
 * The storage and durability settings, held to the rule stated in
 * `shared/env-setting.ts`: an unset setting takes its default, a setting that
 * is present and cannot be understood aborts startup.
 *
 * This is not a new posture for this codebase — it is the one
 * `server/index.ts` already takes for `WHITEBOARD_ALLOWED_WEB_ORIGINS` and the
 * OAuth client registry, for the reason its own comment gives: a silent
 * fallback "would look identical to 'the operator never configured it'". The
 * storage settings were never held to it and had drifted into four different
 * answers for a malformed value — default, `Number.parseInt` prefix, off, and
 * abort.
 */

export const FILE_GC_INTERVAL_ENV = 'WHITEBOARD_FILE_GC_INTERVAL_MS'
export const FILE_GC_GRACE_ENV = 'WHITEBOARD_FILE_GC_GRACE_MS'
export const WORKSPACE_TAIL_ENV = 'WHITEBOARD_WORKSPACE_TAIL_MS'

/** How often the file-GC sweeper runs. `0` disables it. */
export function parseFileGcIntervalMs(
  env: NodeJS.ProcessEnv = process.env,
): ParsedSetting<number | null> {
  return parseOptionalMilliseconds(env[FILE_GC_INTERVAL_ENV], null)
}

/** How old an unreferenced upload must be before a purge may delete it. */
export function parseFileGcGraceMs(
  env: NodeJS.ProcessEnv = process.env,
): ParsedSetting<number | null> {
  return parseOptionalMilliseconds(env[FILE_GC_GRACE_ENV], null)
}

/**
 * How often this instance follows the stored record, or `null` for "do not".
 *
 * `0` is an explicit off and stays meaningful — it is how an operator turns
 * following back off without removing the variable.
 */
export function parseWorkspaceTailMs(
  env: NodeJS.ProcessEnv = process.env,
): ParsedSetting<number | null> {
  const parsed = parseOptionalMilliseconds(env[WORKSPACE_TAIL_ENV], null)
  if (!parsed.ok) return parsed
  return { ok: true, value: parsed.value === 0 ? null : parsed.value }
}

/**
 * Every storage setting this process cannot honour, in one pass.
 *
 * All of them rather than the first: an operator fixing a misconfiguration
 * one restart at a time learns about one variable per attempt, which for a
 * container that takes minutes to come up is its own kind of unusable.
 */
export function collectStorageEnvIssues(
  dataDir: string,
  env: NodeJS.ProcessEnv = process.env,
): EnvIssue[] {
  const issues: EnvIssue[] = []

  for (const [variable, parse] of [
    [FILE_GC_INTERVAL_ENV, parseFileGcIntervalMs],
    [FILE_GC_GRACE_ENV, parseFileGcGraceMs],
    [WORKSPACE_TAIL_ENV, parseWorkspaceTailMs],
  ] as const) {
    const parsed = parse(env)
    if (!parsed.ok) issues.push({ variable, reason: parsed.reason })
  }

  // The database URL already aborts by throwing from wherever it is first
  // opened. Collecting it here moves that failure to startup alongside the
  // others, so an operator with two bad settings is told about both.
  try {
    resolveDatabaseLocation(dataDir, env)
  } catch {
    // The thrown message names the variable and its constraint; it is not
    // reused here because it is built from the value in some branches.
    issues.push({
      variable: DB_URL_ENV,
      reason: 'must be a libsql:, https:, file:, or loopback http: URL',
    })
  }

  return issues
}
