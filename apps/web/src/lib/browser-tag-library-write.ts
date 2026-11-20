import { lease } from '@kamiazya/whiteboard-loro-adapter'
import type { ExtensionFacets } from '@kamiazya/whiteboard-model'
import {
  TAG_LIBRARY_PATH,
  type TagLibrary,
  VISUAL_TAGS_KEY,
  visualTagsFacetSchema,
} from '@kamiazya/whiteboard-plugin-visual'
import type { DocumentIndex } from '@kamiazya/whiteboard-ports'
import { z } from 'zod'
import { ensureBrowserWorkspace } from './browser-document-summary.js'
import { editWorkspaceRecord } from './browser-record-edit.js'
import { getBrowserWorkspaceId } from './browser-workspace-id.js'
import { touchContentTimestamp } from './content-timestamp.js'
import { createSeededDocumentAt } from './create-seeded-document.js'

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
    (await createSeededDocumentAt(index, { path: TAG_LIBRARY_PATH, kind: 'markdown' })).documentId
  await editWorkspaceRecord(
    'The workspace could not be opened to write the tags.',
    dbName,
    async (record) => {
      const prev = await lease.read(
        record,
        { query: 'facets', args: { documentId } },
        z.custom<ExtensionFacets>(),
      )
      return {
        value: undefined,
        writes: [
          {
            op: 'reconcileFacets',
            args: { documentId, prev, next: { ...prev, [VISUAL_TAGS_KEY]: facet } },
          },
        ],
      }
    },
  )
  await touchContentTimestamp(documentId, dbName)
}
