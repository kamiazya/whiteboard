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
 * Neither is decoded here. A spatial document's snapshot travels to the
 * worker as bytes, so this thread's share of a thumbnail is the read and
 * nothing else: decoding cost 1.20ms at 12 nodes, 2.60ms at 40 and 4.60ms at
 * 120, and handing the bytes over costs nothing measurable. What that buys
 * is not a faster picture but a thread that is free while one is drawn.
 *
 * Total by contract. Every failure answers `null` and the row keeps its kind
 * icon: a list that cannot draw a miniature is a plainer list, a list that
 * throws is a broken screen.
 *
 * Every answer goes through the render broker (ADR-0027), which is why the
 * preview pane beside a row no longer redraws what the row just drew: both
 * ask for the same key, and the second one joins the first rather than
 * starting a second render.
 */

import type { BoundingBox } from '@kamiazya/whiteboard-canvas-render'
import type { ResolvedTheme } from '../../hooks/useThemeMode.js'
import { unhandledKind } from '../../lib/exhaustive.js'
import { nextLayoutRequestId, sharedLayoutWorkerPool } from '../../lib/layout-worker-pool.js'
import type { LayoutResponse, MarkdownRenderResponse } from '../../lib/layout-worker-protocol.js'
import type { RenderBroker } from '../../lib/render-broker.js'
import { cacheKeyFor, renderKeyOf } from '../../lib/render-key.js'
import type { WorkspaceDocumentEntry } from './document-entry.js'
import type { WorkspaceFilesSource } from './files-source.js'

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
  readonly source: WorkspaceFilesSource
  /** Spatial rendering resolves its palette from this; markdown takes its ink from CSS. */
  readonly theme: ResolvedTheme
  /**
   * Answers from the memo, joins a render already in flight for the same key,
   * and otherwise runs the pipeline below exactly once.
   */
  readonly broker: RenderBroker
  /**
   * Both renders are injected like the reads above, so the branch that
   * actually produces a picture is assertable without standing up a worker.
   */
  readonly renderMarkdown?: (
    body: string,
    maxWidth: number,
    cacheKey?: string,
  ) => Promise<DocumentRender | null>
  /** Takes the stored SNAPSHOT — the worker decodes it, not this thread. */
  readonly renderSpatial?: (
    snapshot: Uint8Array,
    theme: ResolvedTheme,
    cacheKey?: string,
  ) => Promise<DocumentRender | null>
}

// `cacheKey` rides ON the request rather than being applied around the call:
// the persistent tier lives in the worker, beside the bytes, so reading it
// costs nothing on the thread that asked (ADR-0027 decision 5).
async function renderMarkdownInPool(
  body: string,
  maxWidth: number,
  cacheKey?: string,
): Promise<DocumentRender | null> {
  const reply = await sharedLayoutWorkerPool().run<MarkdownRenderResponse>(
    {
      type: 'markdown-render',
      id: nextLayoutRequestId(),
      body,
      maxWidth,
      ...(cacheKey === undefined ? {} : { cacheKey }),
    },
    'background',
  )
  return reply.type === 'markdown-render-done' ? { svg: reply.svg, bounds: reply.bounds } : null
}

async function renderSpatialInPool(
  snapshot: Uint8Array,
  theme: ResolvedTheme,
  cacheKey?: string,
): Promise<DocumentRender | null> {
  const reply = await sharedLayoutWorkerPool().run<LayoutResponse>(
    {
      type: 'layout',
      id: nextLayoutRequestId(),
      snapshot,
      theme,
      ...(cacheKey === undefined ? {} : { cacheKey }),
    },
    'background',
  )
  return reply.type === 'laid-out' ? { svg: reply.svg, bounds: reply.bounds } : null
}

/**
 * The kind the pipeline will actually take, which is what the key has to
 * agree with. `kind` is optional on a row, and an entry without one is read
 * as spatial below — so the key must say spatial too. Deriving both from
 * here is not tidiness: a key that said `markdown` for a spatially rendered
 * document would drop the theme axis, and one entry would then serve a light
 * and a dark render of the same board.
 */
function renderedKind(document: WorkspaceDocumentEntry): 'spatial' | 'markdown' {
  // A row that does not say its kind is read as spatial, which is what the
  // pipeline below does with it. The switch is what makes a NEW kind a
  // compile error here rather than another silent spatial: being drawn by
  // the wrong pipeline is a picture of the wrong thing, not a missing one.
  const kind = document.kind ?? 'spatial'
  switch (kind) {
    case 'markdown':
      return 'markdown'
    case 'spatial':
      return 'spatial'
    default:
      return unhandledKind(kind, 'renderedKind')
  }
}

export function createRowRenderLoader(deps: RowRenderDeps) {
  const produce = async (
    document: WorkspaceDocumentEntry,
    cacheKey: string | undefined,
  ): Promise<DocumentRender | null> => {
    if (renderedKind(document) === 'markdown') {
      const markdown = await deps.source.loadMarkdown(document)
      if (markdown.trim() === '') return null
      return await (deps.renderMarkdown ?? renderMarkdownInPool)(
        markdown,
        ROW_LAYOUT_WIDTH,
        cacheKey,
      )
    }

    const snapshot = await deps.source.loadSpatialSnapshot(document)
    return await (deps.renderSpatial ?? renderSpatialInPool)(snapshot, deps.theme, cacheKey)
  }

  return async (document: WorkspaceDocumentEntry): Promise<DocumentRender | null> => {
    // The catch stays OUTSIDE the broker: a rejection must not be remembered
    // as an answer, so the broker is allowed to see it and forget the entry,
    // and the totality this loader promises is restored here.
    try {
      const key = renderKeyOf(
        {
          documentId: document.documentId,
          kind: renderedKind(document),
          ...(document.updatedAt === undefined ? {} : { updatedAt: document.updatedAt }),
        },
        deps.theme,
      )
      return await deps.broker.render(key, () => produce(document, cacheKeyFor(key)))
    } catch {
      return null
    }
  }
}
