import { type DocumentContent, documentEditWrites, lease } from '@kamiazya/whiteboard-loro-adapter'
import type { DocumentIndex } from '@kamiazya/whiteboard-ports'
import { planLinkifyMentions } from '@kamiazya/whiteboard-reference-graph'
import { z } from 'zod'
import { editWorkspaceRecord } from './browser-record-edit.js'
import { getBrowserWorkspaceId } from './browser-workspace-id.js'
import { touchContentTimestamp } from './content-timestamp.js'

/**
 * The browser keeper's half of the Connections panel's **Link**: turn the
 * unlinked mentions of `targetDocumentId` in another document into links,
 * and answer how many.
 *
 * What a link is written as, which spans count, and what a board keeps are
 * the shared `planLinkifyMentions`'s — the daemon runs the same function. What
 * is the browser's is WHERE the source lives: a node of this browser's
 * workspace record, edited in place and saved as an incremental update, so the
 * edit is an ordinary CRDT edit that merges with anyone else's rather than a
 * rewrite of the document — and announced, so a page open on the source shows
 * the links without a reload.
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
  const name = target.name
  if (name === undefined) return 0

  const linked = await editWorkspaceRecord(
    'The workspace could not be opened to add the links.',
    dbName,
    async (record) => {
      const content = await lease.read(
        record,
        { query: 'documentContent', args: { documentId: sourceDocumentId, kind: source.kind } },
        z.custom<DocumentContent>(),
      )
      const plan = planLinkifyMentions(content, {
        documentId: target.documentId,
        path: target.path,
        name,
      })
      return {
        value: plan.edit === null ? 0 : plan.linked,
        writes: plan.edit === null ? [] : documentEditWrites(plan.edit, sourceDocumentId),
      }
    },
  )
  if (linked === 0) return 0
  await touchContentTimestamp(sourceDocumentId, dbName)
  return linked
}
