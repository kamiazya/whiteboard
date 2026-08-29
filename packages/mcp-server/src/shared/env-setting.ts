/**
 * The one rule every configurable setting in this package follows.
 *
 * **An unset setting takes its default; a setting that is present and cannot
 * be understood aborts startup.**
 *
 * Setting a value is how an operator states a requirement. Falling back to the
 * default answers that requirement with behaviour they did not ask for and
 * says so nowhere, which is indistinguishable from never having configured it
 * at all. Two measured costs: `WHITEBOARD_FILE_GC_GRACE_MS=1h` meant one
 * millisecond, so the window protecting an in-flight upload was gone; and a
 * misspelled `WHITEBOARD_LOG_LEVEL` silently became `warning`, so an operator
 * who set `debug` to investigate an incident got no debug output and no
 * reason.
 *
 * This module holds only the primitives. Each family declares its own settings
 * (`store/storage-env.ts`, `server/startup-env.ts`), and lives in this package
 * rather than beside any one of them because the daemon client applies the
 * same rule to its own settings.
 *
 * **Blank is not a mistake.** An empty or whitespace value reads as "not
 * configured", the same way the daemon already reads an empty
 * `WHITEBOARD_DATABASE_AUTH_TOKEN`. Surrounding whitespace is likewise
 * trimmed rather than rejected: it is a transport artifact of compose files
 * and shell quoting, not an operator asking for something, and refusing to
 * boot over a stray space would be a hostile reading of an unambiguous value.
 *
 * **Boolean flags are deliberately outside this rule.** `WHITEBOARD_DEBUG`,
 * `WHITEBOARD_DEV` and `WHITEBOARD_NO_WATCH` test `=== '1'`, so `true` and
 * `yes` are off rather than errors. That is the same silent-fallback shape on
 * paper, and it is kept anyway (user decision, 2026-08-29): "exactly `1` is
 * on" is a spec a reader can hold in their head and an operator can satisfy
 * without consulting anything, and a clear narrow spec beats a forgiving one
 * that has to enumerate which spellings of true it accepts. Do not "finish"
 * the convention by extending it here — the omission is the decision.
 */

export type ParsedSetting<T> = { ok: true; value: T } | { ok: false; reason: string }

/**
 * A setting an operator configured that this process cannot honour.
 *
 * Carries the variable NAME and a reason, never the value: these are rendered
 * to stderr and to logs at startup, and a database URL can hold a credential.
 */
export interface EnvIssue {
  variable: string
  reason: string
}

const MILLISECONDS_REASON = 'must be a whole number of milliseconds, with no unit suffix'

/**
 * A bare non-negative base-10 integer, or nothing at all.
 *
 * `fallback` is what an ABSENT setting means, which is not always a number —
 * "off" is a legitimate default, and the caller says so by passing `null`.
 */
export function parseOptionalMilliseconds(
  raw: string | undefined,
  fallback: number | null,
): ParsedSetting<number | null> {
  const trimmed = raw?.trim()
  if (trimmed === undefined || trimmed === '') return { ok: true, value: fallback }
  if (!/^\d+$/.test(trimmed)) return { ok: false, reason: MILLISECONDS_REASON }
  const parsed = Number(trimmed)
  if (!Number.isSafeInteger(parsed)) return { ok: false, reason: 'is too large to be a duration' }
  return { ok: true, value: parsed }
}

/** One line per issue, safe to print: names the variable, never the value. */
export function describeEnvIssues(issues: readonly EnvIssue[]): string {
  return issues.map((issue) => `${issue.variable} ${issue.reason}`).join('; ')
}
