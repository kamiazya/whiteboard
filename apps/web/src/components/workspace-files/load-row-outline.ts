/**
 * Reads one document's shape for a tree row's icon.
 *
 * Kind decides only which read supplies the content: markdown by id from the
 * OKF route, spatial by PATH from the snapshot route. Both then go to the
 * shared worker pool at IDLE priority — a 24px icon is below even a list of
 * thumbnails, which is at least something the person is looking at.
 *
 * Neither is decoded here. A spatial document's snapshot travels to the
 * worker as bytes, so this thread's share of a row icon is the read and
 * nothing else: the decode this replaces cost 1.20ms at 12 nodes, 2.60ms at
 * 40 and 4.60ms at 120, once per visible row, and handing the bytes over
 * costs nothing measurable. What that buys is not a faster icon but a thread
 * that is free while one is drawn.
 *
 * Total by contract. Every failure answers `null` and the row keeps its kind
 * icon: a tree that cannot draw a miniature is a tree with plainer icons, a
 * tree that throws is a broken screen.
 *
 * Every answer goes through the render broker (ADR-0027), under an OUTLINE
 * key — so a row that scrolls away and back, or a tree left and returned to,
 * does not re-read and re-outline what it already has, and cannot be handed
 * the SVG family's answer for the same document.
 */

import { resolveDocumentSymbol, type VisualSymbolFacet } from '@kamiazya/whiteboard-plugin-visual'
import type { WorkspaceDocumentEntry } from '../../lib/document-entry.js'
import { unhandledKind } from '../../lib/exhaustive.js'
import type { FaviconRect } from '../../lib/favicon.js'
import type { WorkspaceFilesSource } from '../../lib/files-source.js'
import { nextLayoutRequestId, sharedLayoutWorkerPool } from '../../lib/layout-worker-pool.js'
import type { OutlineResponse } from '../../lib/layout-worker-protocol.js'
import type { RenderBroker } from '../../lib/render-broker.js'
import { cacheKeyFor, outlineKeyOf } from '../../lib/render-key.js'

/**
 * Width a row's markdown is laid out at. Fixed rather than measured: an icon
 * has no pane, and a shape that changed with the window would make the same
 * document look different on two screens.
 */
const ROW_LAYOUT_WIDTH = 640

/**
 * What one row's read answers with: the document's shape, plus its own mark
 * when it declares one.
 *
 * One value rather than two reads, for the same reason `DocumentOutlineSource`
 * pairs its bytes with a version — both come out of the same decode, and a
 * second read to fetch the symbol would be the decode this whole path exists
 * to keep off the asking thread.
 */
export interface RowOutline {
  readonly rects: readonly FaviconRect[]
  readonly symbol?: VisualSymbolFacet
}

export interface RowOutlineDeps {
  readonly source: WorkspaceFilesSource
  /**
   * Answers from the memo, joins an outline already in flight for the same
   * key, and otherwise runs the pipeline below exactly once.
   */
  readonly broker: RenderBroker
  /**
   * Both outlines are injected like the reads above, so the branch that
   * actually produces a miniature is assertable without standing up a worker.
   */
  readonly outlineMarkdown?: (
    body: string,
    maxWidth: number,
    cacheKey?: string,
  ) => Promise<RowOutline | null>
  /** Takes the stored SNAPSHOT — the worker decodes it, not this thread. */
  readonly outlineSpatial?: (snapshot: Uint8Array, cacheKey?: string) => Promise<RowOutline | null>
}

/** The shared fleet, at idle priority: nobody is waiting on a 24px icon. */
async function outlineInPool(request: Record<string, unknown>): Promise<RowOutline | null> {
  const reply = await sharedLayoutWorkerPool().run<OutlineResponse>(
    { type: 'outline', id: nextLayoutRequestId(), ...request },
    'idle',
  )
  if (reply.type !== 'outlined') return null
  return { rects: reply.rects, ...(reply.symbol === undefined ? {} : { symbol: reply.symbol }) }
}

// `cacheKey` rides ON the request rather than being applied around the call:
// the persistent tier lives in the worker, beside the bytes, so that reading
// it costs nothing on the thread that asked (ADR-0027 decision 5).
const outlineMarkdownInPool = (body: string, maxWidth: number, cacheKey?: string) =>
  outlineInPool({ body, maxWidth, ...(cacheKey === undefined ? {} : { cacheKey }) })
const outlineSpatialInPool = (snapshot: Uint8Array, cacheKey?: string) =>
  outlineInPool({ snapshot, ...(cacheKey === undefined ? {} : { cacheKey }) })

/**
 * The kind the pipeline will actually take, which is what the key has to
 * agree with. `kind` is optional on a row, and an entry without one is read
 * as spatial below — so the key must say spatial too. Deriving both from
 * here is not tidiness: a key disagreeing with the branch is how one entry
 * ends up answering for a document it is not a picture of.
 */
function outlinedKind(document: WorkspaceDocumentEntry): 'spatial' | 'markdown' {
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
      return unhandledKind(kind, 'outlinedKind')
  }
}

export function createRowOutlineLoader(deps: RowOutlineDeps) {
  const produce = async (
    document: WorkspaceDocumentEntry,
    cacheKey: string | undefined,
  ): Promise<RowOutline | null> => {
    if (outlinedKind(document) === 'markdown') {
      const { body, facets } = await deps.source.loadMarkdown(document)
      // The mark comes off the frontmatter, which the same read carried —
      // unlike a spatial document, whose symbol rides the canvas the worker
      // decodes and so comes back from the worker instead.
      const symbol = resolveDocumentSymbol(facets)
      // A body with nothing in it has no shape to draw, and a document that
      // wears a mark still has that. Answering null for both is how a
      // document somebody marked and has not written yet shows a bare kind
      // icon.
      if (body.trim() === '') return symbol === undefined ? null : { rects: [], symbol }
      const outline = await (deps.outlineMarkdown ?? outlineMarkdownInPool)(
        body,
        ROW_LAYOUT_WIDTH,
        cacheKey,
      )
      if (outline === null || symbol === undefined) return outline
      return { ...outline, symbol }
    }

    const snapshot = await deps.source.loadSpatialSnapshot(document)
    return await (deps.outlineSpatial ?? outlineSpatialInPool)(snapshot, cacheKey)
  }

  return async (document: WorkspaceDocumentEntry): Promise<RowOutline | null> => {
    // The catch stays OUTSIDE the broker: a rejection must not be remembered
    // as an answer, so the broker is allowed to see it and forget the entry,
    // and the totality this loader promises is restored here.
    try {
      const key = outlineKeyOf({
        documentId: document.documentId,
        kind: outlinedKind(document),
        ...(document.contentDigest === undefined ? {} : { state: document.contentDigest }),
      })
      return await deps.broker.render(key, () => produce(document, cacheKeyFor(key)))
    } catch {
      return null
    }
  }
}
