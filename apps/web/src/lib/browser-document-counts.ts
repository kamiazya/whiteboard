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
import { readWorkspaceDocuments } from '@kamiazya/whiteboard-loro-adapter'
import { getAppLogger } from './app-logger.js'
import { BrowserWorkspaceDocs } from './browser-workspace-docs.js'
import { foldWorkspaceDocuments } from './fold-workspace.js'
import { IdbDocumentIndex } from './idb-document-index.js'

const log = getAppLogger('browser-document-counts')

/** `dbName`: only tests pass this, exactly as the stores it opens do. */
export async function browserDocumentCounts(dbName?: string): Promise<ReadonlyMap<string, number>> {
  // The shell can be a session's FIRST surface — someone deep-links to a page
  // and opens the switcher without ever opening a document — and nothing
  // folds unconditionally at startup: `FoldingBrowserIndex` folds lazily on
  // its first read, and that read has not happened. Without this, a document
  // written by an older build is still in the legacy row plane, absent from
  // the tree this counts, and the row would quietly read low.
  //
  // Its own catch, and non-fatal, for the reason the Settings surface gives:
  // a fold failure is a storage-side problem that degrades to a pre-fold
  // (undercounted) view, not a reason to answer nothing.
  try {
    await foldWorkspaceDocuments(dbName)
  } catch (err) {
    log.warn('fold before counting failed; counting the tree as it stands', err)
  }

  const docs = new BrowserWorkspaceDocs(dbName)
  const counts = new Map<string, number>()
  for (const workspace of await new IdbDocumentIndex(dbName).listWorkspaces()) {
    // Per workspace, so one unreadable record costs its own row and not the
    // whole popover. A workspace with no record yet is 0 rather than absent:
    // it exists and holds nothing, which is the row a person needs to see.
    try {
      const record = await docs.open(workspace.workspaceId)
      counts.set(workspace.workspaceId, record === null ? 0 : readWorkspaceDocuments(record).length)
    } catch (err) {
      log.warn('could not count a workspace', workspace.workspaceId, err)
    }
  }
  return counts
}
