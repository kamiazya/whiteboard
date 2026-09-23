import { documentContainers, readDocumentKind } from '@kamiazya/whiteboard-loro-adapter'
import type { DocumentIndex } from '@kamiazya/whiteboard-ports'
import { linkifyMentionsIn } from '@kamiazya/whiteboard-reference-graph'
import { BrowserWorkspaceDocs, openWorkspaceOrNull } from './browser-workspace-docs.js'
import { getBrowserWorkspaceId } from './browser-workspace-id.js'
import { touchContentTimestamp } from './loro-store.js'

/**
 * The browser keeper's half of the Connections panel's **Link**: turn the
 * unlinked mentions of `targetDocumentId` in another document into links,
 * and answer how many.
 *
 * What a link is written as, which spans count, and what a board keeps are
 * the shared `linkifyMentionsIn`'s — the daemon runs the same function. What
 * is the browser's is WHERE the source lives: a node of this browser's
 * workspace record, edited in place and saved as an incremental update, so the
 * edit is an ordinary CRDT edit that merges with anyone else's rather than a
 * rewrite of the document.
 */
export async function linkifyBrowserMentions(
  index: DocumentIndex,
  sourceDocumentId: string,
  targetDocumentId: string,
  dbName?: string,
): Promise<number> {
  const workspaceId = getBrowserWorkspaceId()
  const entries = await index.listDocuments({ workspaceId })
  const source = entries.find((entry) => entry.documentId === sourceDocumentId)
  const target = entries.find((entry) => entry.documentId === targetDocumentId)
  if (source === undefined) throw new Error(`No document ${sourceDocumentId} to link from.`)
  if (target === undefined) throw new Error(`No document ${targetDocumentId} to link to.`)
  // Nothing names a document with no display name, so there is no prose to find.
  if (target.name === undefined) return 0

  const docs = new BrowserWorkspaceDocs(dbName)
  const workspace = await openWorkspaceOrNull(docs)
  if (workspace === null) throw new Error('The workspace could not be opened to add the links.')
  const containers = documentContainers(workspace, sourceDocumentId)
  const linked = linkifyMentionsIn(
    containers,
    source.kind ?? readDocumentKind(containers) ?? 'spatial',
    {
      documentId: target.documentId,
      path: target.path,
      name: target.name,
    },
  )
  if (linked === 0) return 0
  await docs.save(workspaceId, workspace)
  await touchContentTimestamp(sourceDocumentId, dbName)
  return linked
}
