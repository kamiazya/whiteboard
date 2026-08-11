/**
 * The mcp-node suite must never touch the developer's real data dir.
 *
 * `getDataDir()` falls back to `~/.whiteboard` when `WHITEBOARD_DATA_DIR` is
 * unset, and several tests boot the server far enough to run migrations. On a
 * machine whose `~/.whiteboard/whiteboard.db` was last migrated by a DIFFERENT
 * build — a sibling checkout on another branch, or the published
 * `@kamiazya/whiteboard-mcp` that `.mcp.json` registers, both of which use
 * that same default dir — the run dies with two unhandled
 * `IncompatibleDatabaseError` rejections while every test still passes. That
 * fails the lefthook pre-push gate for reasons that have nothing to do with
 * the branch being pushed.
 *
 * Asserting on the resolved env var rather than on a log line keeps this
 * independent of which test happens to boot the server today.
 */
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('mcp-node data dir isolation', () => {
  it('points WHITEBOARD_DATA_DIR somewhere other than the real home data dir', () => {
    const configured = process.env.WHITEBOARD_DATA_DIR
    expect(configured, 'WHITEBOARD_DATA_DIR must be set for the mcp-node project').toBeTruthy()
    expect(resolve(configured as string)).not.toBe(resolve(homedir(), '.whiteboard'))
  })

  it('keeps that dir inside the checkout, so two worktrees never share one', () => {
    // A per-worktree path is what stops worktree A's suite colliding with
    // worktree B's daemon; an OS-global temp path would reintroduce it.
    expect(resolve(process.env.WHITEBOARD_DATA_DIR as string)).toContain(
      resolve(import.meta.dirname),
    )
  })
})
