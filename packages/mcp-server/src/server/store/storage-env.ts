import { DB_URL_ENV, resolveDatabaseLocation } from './db/location.js'

/**
 * The storage and durability settings, held to one rule.
 *
 * **An unset setting takes its default; a SET setting that cannot be
 * understood aborts startup.**
 *
 * Setting a value is how an operator states a requirement. Falling back to
 * the default answers that requirement with behaviour they did not ask for,
 * and says so nowhere — the operator goes on believing the retention window
 * they configured is in force. `WHITEBOARD_FILE_GC_GRACE_MS` made the cost
 * concrete: parsed with `Number.parseInt`, `1h` meant one millisecond, and
 * the window protecting an in-flight upload was gone with no error anywhere.
 *
 * This is not a new posture for this codebase — it is the one `server/index.ts`
 * already takes for `WHITEBOARD_ALLOWED_WEB_ORIGINS` and the OAuth client
 * registry, for the reason its own comment gives: a silent fallback "would
 * look identical to 'the operator never configured it'". The storage settings
 * were never held to it and drifted into four different answers for a
 * malformed value — default, `Number.parseInt` prefix, off, and abort.
 *
 * Blank is NOT a mistake. An empty or whitespace value reads as "not
 * configured", the same way the daemon already reads an empty
 * `WHITEBOARD_DATABASE_AUTH_TOKEN`; only a non-blank value that cannot be
 * understood is an issue.
 */

export const FILE_GC_INTERVAL_ENV = 'WHITEBOARD_FILE_GC_INTERVAL_MS'
export const FILE_GC_GRACE_ENV = 'WHITEBOARD_FILE_GC_GRACE_MS'
export const WORKSPACE_TAIL_ENV = 'WHITEBOARD_WORKSPACE_TAIL_MS'

export type ParsedSetting<T> = { ok: true; value: T } | { ok: false; reason: string }

/**
 * A setting an operator configured that this process cannot honour.
 *
 * Carries the variable NAME and a reason, never the value: these are rendered
 * to stderr and logs at startup, and a database URL can hold a credential.
 */
export interface StorageEnvIssue {
  variable: string
  reason: string
}

const INTEGER_REASON = 'must be a whole number of milliseconds, with no unit suffix'

/** A bare non-negative base-10 integer, or nothing at all. */
function parseOptionalMilliseconds(
  raw: string | undefined,
  fallback: number | null,
): ParsedSetting<number | null> {
  const trimmed = raw?.trim()
  if (trimmed === undefined || trimmed === '') return { ok: true, value: fallback }
  if (!/^\d+$/.test(trimmed)) return { ok: false, reason: INTEGER_REASON }
  const parsed = Number(trimmed)
  if (!Number.isSafeInteger(parsed)) return { ok: false, reason: 'is too large to be a duration' }
  return { ok: true, value: parsed }
}

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
): StorageEnvIssue[] {
  const issues: StorageEnvIssue[] = []

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

/** One line per issue, safe to print: names the variable, never the value. */
export function describeStorageEnvIssues(issues: readonly StorageEnvIssue[]): string {
  return issues.map((issue) => `${issue.variable} ${issue.reason}`).join('; ')
}
