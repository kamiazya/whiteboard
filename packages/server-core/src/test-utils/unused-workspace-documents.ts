import type { WorkspaceDocuments } from '../server-deps.js'

/**
 * A `WorkspaceDocuments` that REFUSES rather than answers — the same idiom
 * and reasoning as `unusedLiveDocuments`: a no-op double would let a test
 * that accidentally reaches the workspace doc pass while asserting nothing.
 */
export function unusedWorkspaceDocuments(): WorkspaceDocuments {
  const refuse = (method: string) => (): never => {
    throw new Error(
      `WorkspaceDocuments.${method} was called by a test that passed unusedWorkspaceDocuments().` +
        ' Pass a real implementation if the test is about the workspace doc.',
    )
  }
  return {
    exists: refuse('exists'),
    get: refuse('get'),
    save: refuse('save'),
    evictProjections: refuse('evictProjections'),
    evict: refuse('evict'),
    onUpdated: refuse('onUpdated'),
  }
}
