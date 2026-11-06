/**
 * Where browser-kept document CONTENT is read from and seeded to, the
 * workspace document being the source of truth.
 *
 * Every reader of a document's content goes through
 * `loadDocumentContent`: the workspace document's tree node is the content
 * record, and there is no other place a document's content is read from.
 */
import { projectWorkspaceDocument } from '@kamiazya/whiteboard-loro-adapter'
import type { LoroDoc } from 'loro-crdt'
import { BrowserWorkspaceDocs } from './browser-workspace-docs.js'
import { getBrowserWorkspaceId } from './browser-workspace-id.js'

/**
 * The read did not complete, so nothing is known about the document — as
 * opposed to `null`, which is the document's own answer ("no content here").
 * A caller that caches answers must keep the two apart: this one is worth
 * asking again, and caching it as the other is what leaves a preview blank
 * for good.
 */
class DocumentContentUnreadableError extends Error {
  constructor(readonly documentId: string) {
    super(`document content could not be read: ${documentId}`)
    this.name = 'DocumentContentUnreadableError'
  }
}

/**
 * A document's CURRENT content as a standalone Loro document (a value
 * projection — fresh oplog, current state), or null when the
 * workspace tree does not HOLD it.
 *
 * The ONE read for a browser-kept document nothing has open: the files
 * source, an embed and the reference graph all come through here, so what
 * "current" means is decided once.
 *
 * A read that did not COMPLETE is a different answer and propagates as
 * `DocumentContentUnreadableError`, rather than being folded into "no
 * content": every caller reads that as "this document has no content", and
 * the prefetch caches it as terminal, so ONE transient IndexedDB failure
 * would blank a body's embed for the life of the page — with nothing logged,
 * because the catch would be silent.
 */
export async function loadDocumentContent(
  documentId: string,
  options: { readonly dbName?: string } = {},
): Promise<LoroDoc | null> {
  return projectDocumentContent(await openContentRecord(options.dbName), documentId)
}

/**
 * The workspace record as one read found it, AND whether it could be read at
 * all — the distinction `projectDocumentContent` needs and its callers must
 * not be given: a workspace that did not open says nothing about a document,
 * so a missing tree must not become "no content" beneath it.
 */
export interface ContentRecord {
  readonly workspace: LoroDoc | null
  readonly read: boolean
}

/**
 * Opens the workspace record once. Total on purpose: a read that failed is
 * `read: false`, never a throw.
 *
 * A walk over many documents opens it ONCE and projects each document from
 * that value (`projectDocumentContent`): the record holds every document, so
 * opening it per document made a cold list quadratic in the workspace.
 */
async function openContentRecord(dbName?: string): Promise<ContentRecord> {
  try {
    // Inside an async body, so the synchronous `getBrowserWorkspaceId` throw
    // that `openWorkspaceOrNull` exists to absorb lands in this catch.
    const workspace = await new BrowserWorkspaceDocs(dbName).open(getBrowserWorkspaceId())
    return { workspace, read: true }
  } catch {
    return { workspace: null, read: false }
  }
}

/**
 * `openContentRecord`, deferred to the first document that needs it and
 * shared after — so a walk whose every document is answered from a cache
 * never opens the record at all.
 */
export function lazyContentRecord(dbName?: string): () => Promise<ContentRecord> {
  let opened: Promise<ContentRecord> | undefined
  return () => {
    opened ??= openContentRecord(dbName)
    return opened
  }
}

/**
 * `loadDocumentContent` over a record the caller already opened: the tree's
 * projection, with the same verdicts. A tree that could not be read is the
 * unreadable answer, never `null`.
 */
export async function projectDocumentContent(
  record: ContentRecord,
  documentId: string,
): Promise<LoroDoc | null> {
  const tree = treeProjection(record, documentId)
  if (tree.doc !== null) return tree.doc
  if (!tree.read) throw new DocumentContentUnreadableError(documentId)
  return null
}

/** The tree's answer for one document; a projection that throws is a tree that could not be read. */
function treeProjection(
  record: ContentRecord,
  documentId: string,
): { doc: LoroDoc | null; read: boolean } {
  if (!record.read) return { doc: null, read: false }
  try {
    return {
      doc:
        record.workspace === null ? null : projectWorkspaceDocument(record.workspace, documentId),
      read: true,
    }
  } catch {
    return { doc: null, read: false }
  }
}
