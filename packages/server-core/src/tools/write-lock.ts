import type { ServerDeps } from '../server-deps.js'

/**
 * Runs a load-modify-save inside the workspace's write lock.
 *
 * The lock is the operation's, not an adapter's (ADR-0018 §4): every
 * mutating tool is a load-modify-save against a store whose save writes
 * unconditionally, and the one place that holds the bracket is the one every
 * surface — MCP, HTTP, the next one — goes through. A call that takes it
 * once for a batch makes the batch one point in time: another writer cannot
 * interleave between two documents a caller asked for as a unit.
 *
 * A tool that mutates a document calls this; `tools/arch-lint`'s
 * write-lock-completeness test derives which tools those are from the MCP
 * annotation profiles and names one that does not.
 */
export function withWorkspaceWrite<T>(
  deps: Pick<ServerDeps, 'liveDocuments'>,
  workspaceId: string,
  fn: () => Promise<T>,
): Promise<T> {
  return deps.liveDocuments.withWriteLock(workspaceId, fn)
}
