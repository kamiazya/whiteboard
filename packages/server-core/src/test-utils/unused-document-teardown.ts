import type { DocumentTeardown } from '../server-deps.js'

/**
 * A `DocumentTeardown` for tests whose subject is elsewhere. `begin` throws,
 * so a test that starts deleting documents fails loudly here instead of
 * passing against a double that quietly does nothing — which is exactly the
 * shape of the defect the seam exists to close.
 *
 * The same reasoning as `unusedDocumentIndex`, and deliberately not a
 * no-op: a no-op double would let a delete test pass while asserting
 * nothing about the cleanup, which is the state this repo was in before the
 * seam existed.
 */
export function unusedDocumentTeardown(): DocumentTeardown {
  return {
    begin() {
      throw new Error(
        'documentTeardown.begin: this test composed a DocumentTeardown it does not exercise. ' +
          'Compose a real one if the behaviour under test now depends on document cleanup.',
      )
    },
  }
}

/**
 * A `DocumentTeardown` for a composition that genuinely has nothing outside
 * the store to tear down — server-core's own in-memory tests, where there is
 * no filesystem, no thumbnail and no doc cache.
 *
 * Separate from {@link unusedDocumentTeardown} because the two say different
 * things, and collapsing them would lose the distinction that matters: this
 * one means "the cleanup ran and there was nothing to do", the other means
 * "this test should not be reaching cleanup at all". A single no-op double
 * used everywhere is how a delete test goes back to passing while asserting
 * nothing about the cleanup.
 */
export function inMemoryDocumentTeardown(): DocumentTeardown {
  return {
    async begin() {
      return async () => undefined
    },
  }
}
