/**
 * Renders one document to SVG, for a row's thumbnail and for the preview
 * beside it.
 *
 * Both panes show the same picture at two sizes, so both come from here.
 * The alternative — boxes in the list and a render in the preview — is what
 * made a row's icon and its preview disagree about what a document looks
 * like, and a thumbnail that is not a small version of the thing is not a
 * thumbnail.
 *
 * Kind decides only which read supplies the content: markdown by id from the
 * OKF route, spatial by PATH from the snapshot route. Both then go to the
 * shared worker pool at background priority — a thumbnail is never what
 * someone is waiting on.
 *
 * Total by contract. Every failure answers `null` and the row keeps its kind
 * icon: a list that cannot draw a miniature is a plainer list, a list that
 * throws is a broken screen.
 */

import type { BoundingBox } from '@kamiazya/whiteboard-canvas-render'
import { readSpatialCanvas } from '@kamiazya/whiteboard-loro-adapter'
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { LoroDoc } from 'loro-crdt'
import type { ResolvedTheme } from '../../hooks/useThemeMode.js'
import { nextLayoutRequestId, sharedLayoutWorkerPool } from '../../lib/layout-worker-pool.js'
import type { LayoutResponse, MarkdownRenderResponse } from '../../lib/layout-worker-protocol.js'
import type { WorkspaceDocumentEntry } from './document-entry.js'

export interface DocumentRender {
  readonly svg: string
  /** What the SVG's viewBox covers, so a caller can fit it to any box. */
  readonly bounds: BoundingBox
}

/**
 * Width a row's markdown is laid out at. Fixed rather than measured: a
 * thumbnail has no pane, and a shape that changed with the window would make
 * the same document look different on two screens.
 */
const ROW_LAYOUT_WIDTH = 640

export interface RowRenderDeps {
  readonly daemonFetch: typeof globalThis.fetch
  readonly daemonBaseUrl: string
  readonly workspaceId: string
  /** Spatial rendering resolves its palette from this; markdown takes its ink from CSS. */
  readonly theme: ResolvedTheme
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
  /**
   * The two renders and the snapshot decode are injected like the reads
   * above, so the branch that actually produces a picture is assertable
   * without standing up a worker.
   */
  readonly renderMarkdown?: (body: string, maxWidth: number) => Promise<DocumentRender | null>
  readonly renderSpatial?: (
    canvas: SpatialCanvas,
    theme: ResolvedTheme,
  ) => Promise<DocumentRender | null>
  readonly readCanvas?: (bytes: Uint8Array) => SpatialCanvas
}

async function renderMarkdownInPool(
  body: string,
  maxWidth: number,
): Promise<DocumentRender | null> {
  const reply = await sharedLayoutWorkerPool().run<MarkdownRenderResponse>(
    { type: 'markdown-render', id: nextLayoutRequestId(), body, maxWidth },
    'background',
  )
  return reply.type === 'markdown-render-done' ? { svg: reply.svg, bounds: reply.bounds } : null
}

async function renderSpatialInPool(
  canvas: SpatialCanvas,
  theme: ResolvedTheme,
): Promise<DocumentRender | null> {
  const reply = await sharedLayoutWorkerPool().run<LayoutResponse>(
    { type: 'layout', id: nextLayoutRequestId(), canvas, theme },
    'background',
  )
  return reply.type === 'laid-out' ? { svg: reply.svg, bounds: reply.bounds } : null
}

function decodeCanvas(bytes: Uint8Array): SpatialCanvas {
  const doc = new LoroDoc()
  doc.import(bytes)
  return readSpatialCanvas(doc)
}

export function createRowRenderLoader(deps: RowRenderDeps) {
  return async (document: WorkspaceDocumentEntry): Promise<DocumentRender | null> => {
    try {
      if (document.kind === 'markdown') {
        const { markdown } = await deps.getOkf(
          deps.daemonFetch,
          deps.daemonBaseUrl,
          deps.workspaceId,
          document.documentId,
        )
        if (markdown.trim() === '') return null
        return await (deps.renderMarkdown ?? renderMarkdownInPool)(markdown, ROW_LAYOUT_WIDTH)
      }

      const bytes = await deps.getSnapshot(
        deps.daemonFetch,
        deps.daemonBaseUrl,
        deps.workspaceId,
        document.path,
      )
      const canvas = (deps.readCanvas ?? decodeCanvas)(bytes)
      return await (deps.renderSpatial ?? renderSpatialInPool)(canvas, deps.theme)
    } catch {
      return null
    }
  }
}
