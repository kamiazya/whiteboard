import { generateDocumentId } from '@kamiazya/whiteboard-model'
import { setWhiteboardDbNameForTests } from '../lib/browser-idb.js'
import { setBrowserWorkspaceIdForTests } from '../lib/browser-workspace-id.js'

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
 *
 * Also seeds the `getBrowserWorkspaceId()` test seam with a freshly-minted
 * ULID: a fixture that seeds the isolated DB's `workspaces` store directly
 * (rather than through a real v14 open + resolve) never runs the migration
 * that would otherwise supply one, and the production code paths under test
 * read the accessor synchronously. Every caller in this file already spells
 * `getBrowserWorkspaceId()` where it used to spell the retired
 * `BROWSER_WORKSPACE_ID` constant, so the seeded id is what those calls see.
 */
export function claimIsolatedWhiteboardDb(fileTag: string): string {
  const name = `whiteboard-${fileTag}`
  setWhiteboardDbNameForTests(name)
  setBrowserWorkspaceIdForTests(generateDocumentId())
  return name
}
