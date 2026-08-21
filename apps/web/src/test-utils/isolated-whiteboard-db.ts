import { setWhiteboardDbNameForTests } from '../lib/browser-idb.js'

/**
 * Claim a private IndexedDB for this test FILE, and return its name.
 *
 * Browser test files share one origin and run in parallel pages, so the
 * `whiteboard` database is a single global across all of them — and ten files
 * used to `deleteDatabase('whiteboard')` in `beforeEach`, each one destroying
 * whatever a concurrently-running neighbour had just seeded. The failure then
 * surfaces in the neighbour, which did nothing wrong (the same class as the
 * version-pinning and view-mode incidents, one API over).
 *
 * Call once at module scope. Every opener in this page's module graph — the
 * stores pages construct internally included — resolves the claimed name from
 * then on, so page-level suites are covered without threading a parameter.
 * `clearWhiteboardDb()` clears the claimed database, not the shared one.
 */
export function claimIsolatedWhiteboardDb(fileTag: string): string {
  const name = `whiteboard-${fileTag}`
  setWhiteboardDbNameForTests(name)
  return name
}
