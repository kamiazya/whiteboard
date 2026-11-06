/**
 * How many documents each of the browser keeper's workspaces holds.
 *
 * Its own module, and NOT reachable from `browser-workspaces.ts`, because
 * those two answer questions with different prices. Identity is cheap and the
 * shell needs it on every render to name the current workspace; a count means
 * reading the workspace TREE, which means loro-crdt's WASM — 3039.5 KB. Put
 * them in one module and the cheap question drags the expensive dependency
 * behind a control that renders in the app shell, which is the regression
 * `entry-graph-loro-free.test.ts` and the LCP floor both exist to refuse.
 *
 * So this is imported dynamically, from `counts()` alone, which the switcher
 * calls when its popover OPENS. Measured on the LCP rig's profile (CPU x4,
 * 10Mbps/40ms): 1850 ms over the network, 65 ms out of Cache Storage — and
 * Cache Storage is where it comes from on every visit after the first,
 * because the service worker precaches the WASM so the editor works offline
 * (`check-pwa-precache.mjs` asserts exactly that). This rides a cost the
 * product already pays rather than adding one.
 */
import { isWorkspaceNotFoundError } from '@kamiazya/whiteboard-ports'
import { getAppLogger } from './app-logger.js'
import { BrowserDocumentIndex } from './browser-document-index.js'

const log = getAppLogger('browser-document-counts')

/** `dbName`: only tests pass this, exactly as the stores it opens do. */
export async function browserDocumentCounts(dbName?: string): Promise<ReadonlyMap<string, number>> {
  // Counted by the LISTING, so a count is the number the same workspace
  // opens to, and a workspace the index refuses (its documents predate the
  // tree) is not counted at all rather than counted as empty.
  const index = new BrowserDocumentIndex(dbName)
  const counts = new Map<string, number>()
  const countOne = async (workspaceId: string): Promise<void> => {
    // Per workspace, so one unreadable or refused record costs its own row
    // and not the whole popover. A workspace with no record yet is 0 rather than absent:
    // it exists and holds nothing, which is the row a person needs to see.
    try {
      const rows = await index.listDocuments({ workspaceId })
      counts.set(workspaceId, rows.length)
    } catch (err) {
      if (isWorkspaceNotFoundError(err)) counts.set(workspaceId, 0)
      else log.warn('could not count a workspace', workspaceId, err)
    }
  }
  const workspaces = await index.listWorkspaces()
  await Promise.all(workspaces.map((workspace) => countOne(workspace.workspaceId)))
  return counts
}
