import { documentContainers, readFacets, reconcileFacets } from '@kamiazya/whiteboard-loro-adapter'
import {
  TAG_LIBRARY_PATH,
  type TagLibrary,
  VISUAL_TAGS_KEY,
  visualTagsFacetSchema,
} from '@kamiazya/whiteboard-plugin-visual'
import type { DocumentIndex } from '@kamiazya/whiteboard-ports'
import { ensureBrowserWorkspace } from './browser-document-summary.js'
import {
  BrowserWorkspaceDocs,
  openWorkspaceOrNull,
  saveAndAnnounce,
} from './browser-workspace-docs.js'
import { getBrowserWorkspaceId } from './browser-workspace-id.js'
import { createSeededDocumentAt } from './create-seeded-document.js'
import type { LoroStoreLike } from './loro-store.js'
import { touchContentTimestamp } from './loro-store.js'

/**
 * Writes the workspace's tag library into the document at `tags`, creating
 * that markdown document when the workspace has none.
 *
 * One save of the workspace record, announced like any other content write
 * so a page already open sees the new colours without a reload. The
 * document's other facets and its body are left as they were: only the
 * `visual.tags/v0` entry is replaced.
 */
export async function writeTagLibraryDocument(
  index: DocumentIndex,
  loro: LoroStoreLike,
  library: TagLibrary,
  dbName?: string,
): Promise<void> {
  // Judged here, at the write, as the MCP path does: a library the schema
  // refuses would read back as `{}` and drop every declaration with it.
  const facet = visualTagsFacetSchema.parse({ keys: library })
  await ensureBrowserWorkspace(index)
  const workspaceId = getBrowserWorkspaceId()
  const existing = (await index.listDocuments({ workspaceId })).find(
    (entry) => entry.path === TAG_LIBRARY_PATH,
  )
  const documentId =
    existing?.documentId ??
    (await createSeededDocumentAt(index, loro, { path: TAG_LIBRARY_PATH, kind: 'markdown' }))
      .documentId
  const docs = new BrowserWorkspaceDocs(dbName)
  const workspace = await openWorkspaceOrNull(docs)
  if (workspace === null) throw new Error('The workspace could not be opened to write the tags.')
  const containers = documentContainers(workspace, documentId)
  const prev = readFacets(containers)
  reconcileFacets(containers, prev, { ...prev, [VISUAL_TAGS_KEY]: facet })
  await saveAndAnnounce(docs, workspaceId, workspace)
  await touchContentTimestamp(documentId, dbName)
}
