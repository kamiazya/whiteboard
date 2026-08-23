import type { DocumentWritten } from '../server-deps.js'

/**
 * A `DocumentWritten` for tests with no composition root behind them.
 *
 * A no-op rather than a refusing double, and the asymmetry with
 * `unusedDocumentTeardown` is deliberate: almost every test in this package
 * writes, so a refusal here would fail nearly all of them while catching
 * nothing — it would be noise, not signal. Deleting is rare enough that a
 * test which starts doing it is worth stopping to look at.
 */
export function ignoredDocumentWrites(): DocumentWritten {
  return async () => undefined
}
