/**
 * The editor's right-hand rail: the whole document as a column of blocks,
 * with the visible slice marked, doubling as the scrollbar.
 *
 * Deliberately knows nothing about view modes. It takes blocks, a viewport
 * in document coordinates, and a seek callback — so what "visible" means and
 * what a press scrolls are the editor's decisions, and this component is
 * written once for a source pane, a preview pane, and a split of both.
 *
 * Built from positioned divs rather than an `<svg>`, for the reason the
 * spatial editor's MinimapOverlay gives: the preview in the same editor IS
 * an svg, and tests reach for it with `container.querySelector('svg')`. A
 * second one here would silently answer for the preview.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { cn } from '../../lib/utils.js'
import { RAIL_WIDTH_PX } from './preview-width.js'
import {
  type RailBlock,
  railGeometry,
  railOffsetToDocumentY,
  viewportFrame,
} from './rail-geometry.js'

export interface MinimapRailProps {
  readonly blocks: readonly RailBlock[]
  /** The visible slice, in the same coordinates as `blocks`. */
  readonly viewport: { readonly top: number; readonly height: number }
  /** Called with a document-space y the user pointed at. */
  readonly onSeek: (documentY: number) => void
  readonly className?: string
}

export function MinimapRail({ blocks, viewport, onSeek, className }: MinimapRailProps) {
  const railRef = useRef<HTMLDivElement | null>(null)
  const [railHeight, setRailHeight] = useState(0)

  // The rail's height is whatever the editor gives it, so the geometry has
  // to be recomputed when that changes rather than measured once at mount.
  useEffect(() => {
    const element = railRef.current
    if (element === null || typeof ResizeObserver === 'undefined') return
    setRailHeight(element.clientHeight)
    const observer = new ResizeObserver(() => setRailHeight(element.clientHeight))
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  const geometry = railGeometry(blocks, { railHeight, railWidth: RAIL_WIDTH_PX })
  const frame = viewportFrame(viewport, geometry)

  const seekTo = useCallback(
    (clientY: number) => {
      const element = railRef.current
      if (element === null) return
      const offset = clientY - element.getBoundingClientRect().top
      onSeek(railOffsetToDocumentY(offset, geometry))
    },
    [geometry, onSeek],
  )

  // Pointer capture, so a drag that leaves the rail keeps scrolling rather
  // than stopping at the edge — the behaviour a scrollbar has.
  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId)
    seekTo(event.clientY)
  }
  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return
    seekTo(event.clientY)
  }

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the rail duplicates scrolling, which the panes themselves already expose to the keyboard; it is a pointer shortcut, not the only route
    // biome-ignore lint/a11y/useKeyWithClickEvents: same rationale — no keyboard-only user depends on this element
    <div
      ref={railRef}
      data-testid="markdown-minimap-rail"
      aria-hidden="true"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      style={{ width: RAIL_WIDTH_PX }}
      className={cn(
        'relative shrink-0 cursor-pointer touch-none overflow-hidden border-l',
        'border-border bg-muted/20',
        className,
      )}
    >
      {geometry.rows.map((row, index) => (
        <div
          key={`${row.top}-${index}`}
          className="bg-muted-foreground/45 absolute rounded-[1px]"
          style={{ top: row.top, left: row.left, width: row.width, height: row.height }}
        />
      ))}
      <div
        data-testid="markdown-minimap-viewport"
        // The rail IS the scrollbar, so where you are has to read at a glance
        // against the bars behind it — a marker subtle enough to hunt for
        // fails at the one job it has.
        className="border-foreground/40 bg-foreground/10 pointer-events-none absolute inset-x-0 border-y"
        style={{ top: frame.top, height: frame.height }}
      />
    </div>
  )
}
