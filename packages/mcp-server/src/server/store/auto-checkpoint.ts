import type { CheckpointScheduler } from '@kamiazya/whiteboard-history'
import type { LoroDoc } from 'loro-crdt'

/**
 * The one automatic-checkpoint scheduler, shared by every path that writes a
 * document.
 *
 * It is the keeper's own, not a second scheduler built here: the HTTP roots
 * install the one their router signals (it carries what only the root knows
 * — the daemon's actor, the broadcast on a saved row, the quiet window a
 * test shortens), and the stdio root, which mounts no router, builds the
 * same one over the same store. Both install it through the `auto-checkpoint`
 * declaration in `shared-background-work.ts`, which also flushes it at
 * shutdown. Two schedulers over one workspace would each hold pending state
 * for the same document.
 *
 * Held at module scope for the reason `installAutoCompact` is: the agent
 * write path reaches this through a `documentWritten` seam with no router in
 * its call chain.
 *
 * ponytail: one scheduler for the process, whatever the workspace. A root
 * that ever needs a per-workspace quiet window or actor swaps this for a
 * lookup keyed by workspace id.
 */
let installed: CheckpointScheduler | null = null

export function installAutoCheckpoint(scheduler: CheckpointScheduler): void {
  installed = scheduler
}

export function uninstallAutoCheckpointForTests(): void {
  installed = null
}

/** "This document just changed" — a no-op while no scheduler is installed. */
export function checkpointAfterWrite(workspaceId: string, path: string, doc: LoroDoc): void {
  installed?.(workspaceId, path, doc)
}
