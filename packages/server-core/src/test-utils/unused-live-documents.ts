import type { LiveDocuments } from '../server-deps.js'

/**
 * A `LiveDocuments` that REFUSES rather than answers, for a test whose
 * subject is something else — the same idiom as `unusedDocumentTeardown`
 * and `unusedVersionHistory`, and for the same reason: a no-op double would
 * let a test that accidentally reaches the live-document store pass while
 * asserting nothing, and read exactly like one that never reached it.
 *
 * A test that means to exercise live documents passes its own.
 */
export function unusedLiveDocuments(): LiveDocuments {
  const refuse = (method: string) => (): never => {
    throw new Error(
      `LiveDocuments.${method} was called by a test that passed unusedLiveDocuments().` +
        ' Pass a real implementation if the test is about live documents.',
    )
  }
  return {
    get: refuse('get'),
    save: refuse('save'),
    exists: refuse('exists'),
    kind: refuse('kind'),
    list: refuse('list'),
    rename: refuse('rename'),
    delete: refuse('delete'),
    evict: refuse('evict'),
    withWriteLock: refuse('withWriteLock'),
  }
}
