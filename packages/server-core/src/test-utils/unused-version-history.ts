import type { VersionHistory } from '../server-deps.js'

/**
 * A `VersionHistory` that REFUSES rather than answers, for a test whose
 * subject is something else.
 *
 * Throwing, not `null`-returning, and the distinction is the whole point:
 * `null` is a real answer from this seam — "no such version", "not a
 * workspace-scoped version" — so a null-returning double would let a test
 * that accidentally reaches history pass while asserting nothing, and read
 * exactly like one that never reached it. Same reasoning as
 * `unusedDocumentTeardown`.
 *
 * A test that means to exercise history passes its own.
 */
export function unusedVersionHistory(): VersionHistory {
  const refuse = (method: string) => (): never => {
    throw new Error(
      `VersionHistory.${method} was called by a test that passed unusedVersionHistory().` +
        ' Pass a real history if the test is about saved versions.',
    )
  }
  return {
    load: refuse('load'),
    loadWorkspaceAt: refuse('loadWorkspaceAt'),
    list: refuse('list'),
  }
}
