import type { CheckpointScheduler } from '@kamiazya/whiteboard-history'
import type { LoroDoc } from 'loro-crdt'

/**
 * The one automatic-checkpoint scheduler, shared by every path that writes a
 * document.
 *
 * It is the router's own (`routes/document.ts` installs it), not a second
 * scheduler built here: it carries what only the root knows — the daemon's
 * actor, the broadcast on a saved row, the quiet window a test shortens — and
 * the root already flushes it at shutdown. Two schedulers over one workspace
 * would also each hold pending state for the same document.
 *
 * Held at module scope for the reason `installAutoCompact` is: the agent
 * write path reaches this through a `documentWritten` seam with no router in
 * its call chain.
 *
 * ponytail: nothing is installed in the stdio entry, which mounts no router,
 * so a stdio-only workspace takes no automatic checkpoint. Build a default
 * scheduler here when stdio needs one; the daemon's `/mcp` is covered.
 */
let installed: CheckpointScheduler | null = null

export function installAutoCheckpoint(scheduler: CheckpointScheduler): void {
  installed = scheduler
}

export function uninstallAutoCheckpoint(): void {
  installed = null
}

/** "This document just changed" — a no-op while no scheduler is installed. */
export function checkpointAfterWrite(workspaceId: string, path: string, doc: LoroDoc): void {
  installed?.(workspaceId, path, doc)
}
