/**
 * Reads one document's shape for a tree row's icon.
 *
 * Kind decides where the shape comes from, and the two are genuinely
 * different reads: a spatial canvas already IS boxes, so its snapshot is
 * enough; a markdown document has none of its own and has to be laid out,
 * which happens in the shared worker pool at background priority.
 *
 * Total by contract — every failure answers `null` and the row keeps its
 * kind icon. A tree that cannot draw a miniature is a tree with plainer
 * icons; a tree that throws is a broken screen.
 */

import { readSpatialCanvas } from '@kamiazya/whiteboard-loro-adapter'
import { LoroDoc } from 'loro-crdt'
import { outlineFromSpatial } from '../../lib/document-outline.js'
import type { FaviconRect } from '../../lib/favicon.js'
import { nextLayoutRequestId, sharedLayoutWorkerPool } from '../../lib/layout-worker-pool.js'
import type { MarkdownRailResponse } from '../../lib/layout-worker-protocol.js'
import type { WorkspaceFileTreeDocument } from './WorkspaceFileTree.js'

/**
 * Width a row's markdown is laid out at. Fixed rather than measured: an icon
 * has no pane, and a shape that changed with the window would make the same
 * document look different on two screens.
 */
const ROW_LAYOUT_WIDTH = 640

export interface RowOutlineDeps {
  readonly daemonFetch: typeof globalThis.fetch
  readonly daemonBaseUrl: string
  readonly workspaceId: string
  readonly getSnapshot: (
    fetchFn: typeof globalThis.fetch,
    baseUrl: string,
    workspaceId: string,
    path: string,
  ) => Promise<Uint8Array>
  readonly getOkf: (
    fetchFn: typeof globalThis.fetch,
    baseUrl: string,
    workspaceId: string,
    documentId: string,
  ) => Promise<{ markdown: string }>
}

export function createRowOutlineLoader(deps: RowOutlineDeps) {
  return async (document: WorkspaceFileTreeDocument): Promise<readonly FaviconRect[] | null> => {
    try {
      if (document.kind === 'markdown') {
        const { markdown } = await deps.getOkf(
          deps.daemonFetch,
          deps.daemonBaseUrl,
          deps.workspaceId,
          document.documentId,
        )
        if (markdown.trim() === '') return null
        const reply = await sharedLayoutWorkerPool().run<MarkdownRailResponse>(
          {
            type: 'markdown-rail',
            id: nextLayoutRequestId(),
            body: markdown,
            maxWidth: ROW_LAYOUT_WIDTH,
          },
          'background',
        )
        return reply.type === 'markdown-rail-done' ? reply.blocks : null
      }

      const bytes = await deps.getSnapshot(
        deps.daemonFetch,
        deps.daemonBaseUrl,
        deps.workspaceId,
        document.path,
      )
      const doc = new LoroDoc()
      doc.import(bytes)
      return outlineFromSpatial(readSpatialCanvas(doc))
    } catch {
      return null
    }
  }
}
