/**
 * A tree row's icon: a miniature of the document's own shape.
 *
 * At this size nothing readable survives, which is the point — the
 * arrangement is what tells one document from another, the same reasoning
 * the favicon has always used. It reuses the favicon's projection so the two
 * renditions of one document agree.
 *
 * Loading is deferred to first sight (`useOnScreen`): a tree lists far more
 * rows than fit, and each miniature costs a fetch of that document's bytes.
 * Measured before choosing this over a server-side outline endpoint — a Loro
 * snapshot stays small even with history (200 nodes and 200 edits is 19KB),
 * so a per-row fetch is affordable and both modes keep one code path.
 */

import { FileText, LayoutGrid } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useOnScreen } from '../../hooks/useOnScreen.js'
import type { FaviconRect } from '../../lib/favicon.js'
import { fitMinimap, projectBox } from '../spatial-editor/minimap.js'
import type { WorkspaceFileTreeDocument } from './WorkspaceFileTree.js'

/**
 * The icon's own box, in percent-of-element units.
 *
 * NOT the favicon's `projectRectsToBoard`: that inset reserves room for the
 * board outline and status dot a favicon draws, which a bare icon has
 * neither of — measured on the real tree, it squeezed every shape into a row
 * of horizontal dashes. Same underlying geometry (`fitMinimap`/`projectBox`,
 * the spatial minimap's), different wrapper.
 */
const BOARD = { width: 100, height: 100 }

/**
 * Percent, so a rect survives at any icon size. Below roughly this the shape
 * reads as a smudge rather than an arrangement.
 */
const MIN_EXTENT_PCT = 6

/** Beyond this the shapes overlap into noise at icon size. */
const MAX_RECTS = 10

export interface DocumentMinimapProps {
  readonly document: WorkspaceFileTreeDocument
  /**
   * Reads a document's shape. Injected rather than fetched here so this
   * component stays free of the daemon client — and so a test can answer
   * without a network or a worker.
   */
  readonly loadOutline: (
    document: WorkspaceFileTreeDocument,
  ) => Promise<readonly FaviconRect[] | null>
}

/** The largest few rects, fitted to the whole icon box. */
function projectForIcon(
  rects: readonly FaviconRect[],
): { x: number; y: number; w: number; h: number }[] {
  if (rects.length === 0) return []
  const kept = [...rects].sort((a, b) => b.w * b.h - a.w * a.h).slice(0, MAX_RECTS)
  const boxes = kept.map((r) => ({ x: r.x, y: r.y, width: r.w, height: r.h }))
  // No viewport concept here, so the first box stands in for it — fitMinimap
  // never widens the fitted bounds past the content.
  const fit = fitMinimap(boxes, boxes[0] as (typeof boxes)[number], BOARD, 0)
  return boxes.map((box) => {
    const p = projectBox(box, fit)
    return {
      x: p.x,
      y: p.y,
      w: Math.max(MIN_EXTENT_PCT, p.width),
      h: Math.max(MIN_EXTENT_PCT, p.height),
    }
  })
}

export function DocumentMinimap({ document, loadOutline }: DocumentMinimapProps) {
  const [ref, onScreen] = useOnScreen<HTMLSpanElement>()
  const [rects, setRects] = useState<readonly FaviconRect[] | null>(null)

  useEffect(() => {
    if (!onScreen) return
    let live = true
    loadOutline(document)
      .then((loaded) => {
        if (live && loaded !== null && loaded.length > 0) setRects(loaded)
      })
      // A row that cannot be read keeps its kind icon. A miniature is a
      // convenience; failing to draw one must not cost the row itself.
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [onScreen, document, loadOutline])

  const projected = rects === null ? null : projectForIcon(rects)

  return (
    <span
      ref={ref}
      data-testid="document-minimap"
      aria-hidden="true"
      className="relative inline-block size-6 shrink-0 overflow-hidden"
    >
      {projected === null || projected.length === 0 ? (
        document.kind === 'spatial' ? (
          <LayoutGrid data-kind="spatial" className="text-muted-foreground size-6" />
        ) : (
          <FileText
            data-kind={document.kind ?? 'markdown'}
            className="text-muted-foreground size-6"
          />
        )
      ) : (
        // Positioned spans rather than an <svg>: the panel beside this one
        // renders the preview as an svg, and tests reach for it with
        // container.querySelector('svg') — a second one here would answer for
        // it. The same reason MinimapOverlay gives.
        projected.map((rect, index) => (
          <span
            key={`${rect.x}-${rect.y}-${index}`}
            className="absolute bg-current opacity-45"
            style={{
              left: `${rect.x}%`,
              top: `${rect.y}%`,
              width: `${rect.w}%`,
              height: `${rect.h}%`,
            }}
          />
        ))
      )}
    </span>
  )
}
