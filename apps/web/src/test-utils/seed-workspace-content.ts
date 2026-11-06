import { writeWorkspaceDocumentContent } from '@kamiazya/whiteboard-loro-adapter'
import type { DocumentKind } from '@kamiazya/whiteboard-model'
import type { DocumentEntry } from '@kamiazya/whiteboard-ports'
import { LoroDoc } from 'loro-crdt'
import { BrowserDocumentIndex } from '../lib/browser-document-index.js'
import { BrowserWorkspaceDocs, openWorkspaceOrNull } from '../lib/browser-workspace-docs.js'
import { getBrowserWorkspaceId } from '../lib/browser-workspace-id.js'
import { touchContentTimestamp } from '../lib/content-timestamp.js'

/**
 * Writes standalone-document bytes INTO an existing tree node and stamps its
 * listing clock, so a test can give a document content. Returns false when the
 * workspace record or the node is absent.
 */
export async function seedWorkspaceDocumentContent(
  documentId: string,
  content: Uint8Array,
  dbName?: string,
): Promise<boolean> {
  const docs = new BrowserWorkspaceDocs(dbName)
  const workspace = await openWorkspaceOrNull(docs)
  if (workspace === null) return false
  const source = new LoroDoc()
  source.import(content)
  if (!writeWorkspaceDocumentContent(workspace, documentId, source)) return false
  await docs.save(getBrowserWorkspaceId(), workspace)
  await touchContentTimestamp(documentId, dbName)
  return true
}

/**
 * Creates one document in the workspace tree through the production index —
 * the way every surface creates one — and, when `content` is given, writes
 * those standalone-document bytes into its node. The registry row is made
 * first when absent, as boot's resolve finds it in production.
 */
export async function seedTreeDocument(
  input: {
    readonly workspaceId?: string
    readonly path: string
    readonly kind: DocumentKind
    readonly name?: string
    readonly content?: Uint8Array
  },
  dbName?: string,
): Promise<DocumentEntry> {
  const workspaceId = input.workspaceId ?? getBrowserWorkspaceId()
  const index = new BrowserDocumentIndex(dbName)
  await index.createWorkspace({ workspaceId })
  const entry = await index.createDocument({
    workspaceId,
    path: input.path,
    kind: input.kind,
    ...(input.name === undefined ? {} : { name: input.name }),
  })
  if (input.content !== undefined) await seedTreeContent(entry.documentId, input.content, dbName)
  else await touchContentTimestamp(entry.documentId, dbName)
  return entry
}

/** `seedWorkspaceDocumentContent` for a node the test knows exists: absent is a broken fixture. */
export async function seedTreeContent(
  documentId: string,
  content: Uint8Array,
  dbName?: string,
): Promise<void> {
  if (!(await seedWorkspaceDocumentContent(documentId, content, dbName))) {
    throw new Error(`seedTreeContent: no tree node for ${documentId}`)
  }
}
