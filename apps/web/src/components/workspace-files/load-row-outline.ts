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

import { unhandledKind } from '../../lib/exhaustive.js'
import type { FaviconRect } from '../../lib/favicon.js'
import { nextLayoutRequestId, sharedLayoutWorkerPool } from '../../lib/layout-worker-pool.js'
import type { OutlineResponse } from '../../lib/layout-worker-protocol.js'
import type { RenderBroker } from '../../lib/render-broker.js'
import { outlineKeyOf } from '../../lib/render-key.js'
import type { WorkspaceDocumentEntry } from './document-entry.js'
import type { WorkspaceFilesSource } from './files-source.js'

/**
 * Width a row's markdown is laid out at. Fixed rather than measured: an icon
 * has no pane, and a shape that changed with the window would make the same
 * document look different on two screens.
 */
const ROW_LAYOUT_WIDTH = 640

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
  ) => Promise<readonly FaviconRect[] | null>
  /** Takes the stored SNAPSHOT — the worker decodes it, not this thread. */
  readonly outlineSpatial?: (snapshot: Uint8Array) => Promise<readonly FaviconRect[] | null>
}

/** The shared fleet, at idle priority: nobody is waiting on a 24px icon. */
async function outlineInPool(
  request: Record<string, unknown>,
): Promise<readonly FaviconRect[] | null> {
  const reply = await sharedLayoutWorkerPool().run<OutlineResponse>(
    { type: 'outline', id: nextLayoutRequestId(), ...request },
    'idle',
  )
  return reply.type === 'outlined' ? reply.rects : null
}

const outlineMarkdownInPool = (body: string, maxWidth: number) => outlineInPool({ body, maxWidth })
const outlineSpatialInPool = (snapshot: Uint8Array) => outlineInPool({ snapshot })

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
  ): Promise<readonly FaviconRect[] | null> => {
    if (outlinedKind(document) === 'markdown') {
      const markdown = await deps.source.loadMarkdown(document)
      if (markdown.trim() === '') return null
      return await (deps.outlineMarkdown ?? outlineMarkdownInPool)(markdown, ROW_LAYOUT_WIDTH)
    }

    const snapshot = await deps.source.loadSpatialSnapshot(document)
    return await (deps.outlineSpatial ?? outlineSpatialInPool)(snapshot)
  }

  return async (document: WorkspaceDocumentEntry): Promise<readonly FaviconRect[] | null> => {
    // The catch stays OUTSIDE the broker: a rejection must not be remembered
    // as an answer, so the broker is allowed to see it and forget the entry,
    // and the totality this loader promises is restored here.
    try {
      const key = outlineKeyOf({
        documentId: document.documentId,
        kind: outlinedKind(document),
        ...(document.updatedAt === undefined ? {} : { updatedAt: document.updatedAt }),
      })
      return await deps.broker.render(key, () => produce(document))
    } catch {
      return null
    }
  }
}
