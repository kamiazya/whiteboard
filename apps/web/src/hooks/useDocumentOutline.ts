/**
 * A document's shape, whichever kind it is — the one input every small
 * rendition of it takes: the favicon, a tree row's icon, a list card.
 *
 * SUBSCRIBED, not derived. It used to be a `useMemo` in the page's render
 * path, so every edit computed an outline that the next edit threw away 150ms
 * later, on the thread answering the person doing the editing. Now the
 * document's own change notification triggers it, the worker computes it at
 * IDLE priority — nobody waits on a tab icon — and the page holds the last
 * answer until a better one arrives.
 *
 * Safety and freshness come from different places, which is what the two
 * triggers are for. SAFETY is `readOutlineSource` reading the bytes and the
 * version out of the same committed document in one synchronous block, so
 * whatever is drawn is filed under the version it actually is. FRESHNESS is
 * only about asking often enough, and is best-effort by design — nobody is
 * waiting on a tab icon.
 *
 * So it asks on BOTH the document's change notification and the published
 * value, rather than picking one. Measured in the running app: typing into a
 * markdown document in browser mode fires no `whiteboard:doc_changed` at all
 * (`dispatchIdentityEvent` returns early without a workspace identity, which
 * is why `useDirtyState`'s save dot stays clean there too), so an outline
 * driven by the event alone never updated. The published value is what
 * covers that; the event is what covers a change that arrives without one.
 * Asking twice for one state costs a map lookup — the version is the same,
 * so the second ask is answered from the memo.
 */

import type { DocumentKind } from '@kamiazya/whiteboard-model'
import { useEffect, useState } from 'react'
import type { DocumentOutlineSource } from '../lib/document-outline.js'
import { DOCUMENT_SYNC_CHANGED_EVENT } from '../lib/document-sync-types.js'
import type { FaviconRect } from '../lib/favicon.js'
import { nextLayoutRequestId, sharedLayoutWorkerPool } from '../lib/layout-worker-pool.js'
import type { OutlineResponse } from '../lib/layout-worker-protocol.js'
import type { RenderBroker } from '../lib/render-broker.js'
import { outlineKeyOf } from '../lib/render-key.js'

/**
 * The width a markdown document is laid out at for these renditions. Fixed
 * rather than the editor's measured pane: an icon has no pane, and a shape
 * that changed with the window would make the same document look different
 * on two screens.
 */
const OUTLINE_LAYOUT_WIDTH = 640

/** Stable identity, so a document with no shape yet never re-renders a consumer. */
const NO_RECTS: readonly FaviconRect[] = []

/** The shared fleet at idle priority: a tab icon is below even a list. */
async function outlineInPool(
  source: DocumentOutlineSource,
): Promise<readonly FaviconRect[] | null> {
  const reply = await sharedLayoutWorkerPool().run<OutlineResponse>(
    {
      type: 'outline',
      id: nextLayoutRequestId(),
      ...(source.snapshot === undefined
        ? { body: source.body, maxWidth: OUTLINE_LAYOUT_WIDTH }
        : { snapshot: source.snapshot }),
    },
    'idle',
  )
  return reply.type === 'outlined' ? reply.rects : null
}

export function useDocumentOutline({
  documentId,
  kind,
  revision,
  readSource,
  broker,
  outline = outlineInPool,
}: {
  /** `null` before the page is editing a document; nothing is asked for then. */
  documentId: string | null
  kind: DocumentKind
  /**
   * Whatever the page re-renders with when this document changes — its
   * canvas value or its body. Only its IDENTITY is read, never its content:
   * what is drawn always comes from `readSource`, so this is a trigger and
   * not a second source that could disagree with the version key.
   */
  revision: unknown
  /** Reads the bytes-or-body and the version TOGETHER; see its own doc. */
  readSource: (kind: DocumentKind) => DocumentOutlineSource | null
  broker: RenderBroker
  /** Injected so the branch that produces a shape is assertable without a worker. */
  outline?: (source: DocumentOutlineSource) => Promise<readonly FaviconRect[] | null>
}): readonly FaviconRect[] {
  const [rects, setRects] = useState<readonly FaviconRect[]>(NO_RECTS)

  useEffect(() => {
    let live = true

    const run = () => {
      if (documentId === null) return
      const source = readSource(kind)
      if (source === null) return
      // An empty body lays out to nothing; asking the pool for it spends a
      // slot to produce no rectangles.
      if (source.body !== undefined && source.body.trim() === '') {
        setRects(NO_RECTS)
        return
      }
      const key = outlineKeyOf({ documentId, kind, updatedAt: source.frontier })
      broker
        .render(key, () => outline(source))
        .then((next) => {
          if (live && next !== null) setRects(next)
        })
        // A shape that cannot be computed leaves the last one showing. A
        // favicon is a convenience; failing to draw one must not throw.
        .catch(() => undefined)
    }

    run()
    // Not filtered by document identity, deliberately: `readSource` reads
    // THIS page's own session, so another document's change produces the
    // same version here and answers from the memo. Filtering would add a
    // second place for the two pages' identities to disagree, to save a map
    // lookup.
    window.addEventListener(DOCUMENT_SYNC_CHANGED_EVENT, run)
    return () => {
      live = false
      window.removeEventListener(DOCUMENT_SYNC_CHANGED_EVENT, run)
    }
  }, [documentId, kind, revision, readSource, broker, outline])

  return rects
}
