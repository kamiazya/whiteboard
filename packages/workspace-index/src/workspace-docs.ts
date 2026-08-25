import type { LoroDoc } from 'loro-crdt'

/**
 * Where a workspace's Loro document comes from, and where a change to it goes.
 *
 * The one thing this package does not decide. A workspace document is bytes in
 * a store — libSQL in the daemon, IndexedDB in the browser — and both roots
 * already own that machinery; what neither should own is a second copy of the
 * index rules on top of it.
 *
 * `save` exists rather than the index writing through the document itself
 * because Loro commits into memory: nothing reaches a store until somebody
 * exports and writes. Making that a step the seam names keeps a caller from
 * assuming a mutation persisted when it only converged locally.
 */
export interface WorkspaceDocs {
  /**
   * The workspace's document, or `null` when it does not exist.
   *
   * `null` rather than an empty document, because "no such workspace" is an
   * error the port has to raise and an empty workspace is not.
   */
  open(workspaceId: string): Promise<LoroDoc | null>
  /**
   * Creates the workspace's document, or answers the existing one.
   *
   * Idempotent, matching `createWorkspace`: a caller that wants the workspace
   * to be there is served either way.
   */
  create(workspaceId: string): Promise<LoroDoc>
  /** Persists whatever the index just changed. */
  save(workspaceId: string, doc: LoroDoc): Promise<void>
}
