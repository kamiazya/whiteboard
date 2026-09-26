/**
 * Empties this project's test data dir before the run.
 *
 * A database migrated by an older branch must not outlive a branch switch in
 * the same worktree: it would record migrations the current build no longer
 * ships and fail the whole run with an `IncompatibleDatabaseError` that has
 * nothing to do with the tests. Starting empty makes each run self-contained.
 *
 * Then migrates it, ONCE, before any worker starts. Every test file is its
 * own process, and a route that resolves a workspace handle opens this
 * database and migrates it on first use — so two files doing that at once
 * race on the same DDL (`table "tenants" already exists`, `SQLITE_BUSY`) and
 * the loser answers 500 inside whichever test asked. Migrated here, each
 * worker's own pass finds nothing to do.
 *
 * Left in place afterwards on purpose — a failed run's database is often the
 * only evidence of what went wrong, and the next run clears it.
 */
import { rmSync } from 'node:fs'
import { closeDb } from './src/server/store/db/index.js'
import { prepareDataDir } from './src/server/store/db/prepare.js'
import { MCP_NODE_DATA_DIR } from './vitest.node.config.js'

export default async function setup(): Promise<void> {
  rmSync(MCP_NODE_DATA_DIR, { recursive: true, force: true })
  await prepareDataDir(MCP_NODE_DATA_DIR)
  await closeDb(MCP_NODE_DATA_DIR)
}
