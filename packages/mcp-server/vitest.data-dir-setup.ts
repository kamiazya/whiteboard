/**
 * Empties this project's test data dir before the run.
 *
 * A database migrated by an older branch must not outlive a branch switch in
 * the same worktree: it would record migrations the current build no longer
 * ships and fail the whole run with an `IncompatibleDatabaseError` that has
 * nothing to do with the tests. Starting empty makes each run self-contained.
 *
 * Left in place afterwards on purpose — a failed run's database is often the
 * only evidence of what went wrong, and the next run clears it.
 */
import { rmSync } from 'node:fs'
import { MCP_NODE_DATA_DIR } from './vitest.node.config.js'

export default function setup(): void {
  rmSync(MCP_NODE_DATA_DIR, { recursive: true, force: true })
}
