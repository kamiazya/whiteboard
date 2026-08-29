import type { EnvIssue } from '../shared/env-setting.js'
import { LOG_LEVELS, parseLogLevel } from './log.js'
import { collectStorageEnvIssues } from './store/storage-env.js'

/**
 * Every setting a startup path reads, held to the rule in
 * `shared/env-setting.ts`: an unset setting takes its default, a setting that
 * is present and cannot be understood aborts startup.
 *
 * One composer rather than the check being repeated at each entry point. The
 * daemon and `whiteboard server run` are two startup paths reading the same
 * environment, and a family added to one but not the other is exactly the
 * silent gap this whole convention exists to close.
 */

const LOG_LEVEL_ENV = 'WHITEBOARD_LOG_LEVEL'

/**
 * `WHITEBOARD_LOG_LEVEL` is checked here rather than in `log.ts`.
 *
 * The logger cannot abort on its own setting: it is what would report the
 * failure, and it is constructed before any startup path runs. So
 * `resolveInitialLevel` keeps its safe fallback and this gate refuses the
 * value before the process gets far enough to rely on it — the same split the
 * storage resolvers use.
 *
 * It exists because the failure is silent at the worst possible moment: an
 * operator who sets `debug` to investigate an incident, and misspells it, gets
 * `warning` output and no reason. Nothing about the level being diagnostic
 * rather than data makes that acceptable — a stated requirement was answered
 * with something else.
 *
 * The gate must not be STRICTER than the logger. `parseLogLevel` already
 * lower-cases and accepts `warn` for `warning`, so those pass here too; this
 * rejects only what the logger would silently drop.
 */
function collectLogLevelIssue(env: NodeJS.ProcessEnv): EnvIssue[] {
  const raw = env[LOG_LEVEL_ENV]?.trim()
  if (raw === undefined || raw === '') return []
  if (parseLogLevel(raw) !== null) return []
  return [{ variable: LOG_LEVEL_ENV, reason: `must be one of: ${LOG_LEVELS.join(', ')}` }]
}

/**
 * Every setting this process cannot honour, in one pass.
 *
 * All of them rather than the first: an operator fixing a misconfiguration one
 * restart at a time learns about one variable per attempt, which for a
 * container that takes minutes to come up is its own kind of unusable.
 */
export function collectStartupEnvIssues(
  dataDir: string,
  env: NodeJS.ProcessEnv = process.env,
): EnvIssue[] {
  return [...collectStorageEnvIssues(dataDir, env), ...collectLogLevelIssue(env)]
}
