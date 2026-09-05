// The pan/zoom viewport state and its keyboard-facing controls, extracted
// from SpatialEditor. The math lives in viewport.ts (pure, purity-scanned);
// this hook owns the one `viewport` React state and the frame/zoom verbs
// built over it. Pointer-driven navigation (wheel, hand pan, pinch) stays
// with the pointer wiring in the editor — those handlers read gesture refs
// this hook has no business holding — but they drive the same setViewport
// returned here, so there is exactly one viewport.

import { useState } from 'react'
import type { NodeBox } from '../../lib/spatial/geometry.js'
import {
  type ContainerSize,
  contentBounds,
  frameViewport,
  IDENTITY_VIEWPORT,
  type Point,
  type Viewport,
  zoomAt,
} from '../../lib/spatial/viewport.js'

/** Margin around framed content, in screen px. */
const FRAME_MARGIN_PX = 24

export interface ViewportControlsInputs {
  rootRef: { current: HTMLDivElement | null }
  boxes: readonly NodeBox[]
  /** The primary selection, when one exists (frameSelection frames it + extras). */
  selection: { id: string } | undefined
  extraIds: ReadonlySet<string>
  viewportCenterScreen: () => Point
  containerSizeOf: (root: HTMLDivElement | null) => ContainerSize | null
}

export function useViewportControls({
  rootRef,
  boxes,
  selection,
  extraIds,
  viewportCenterScreen,
  containerSizeOf,
}: ViewportControlsInputs) {
  const [viewport, setViewport] = useState<Viewport>(IDENTITY_VIEWPORT)

  /** Keyboard zoom: about the viewport centre, since there is no pointer. */
  const stepZoom = (factor: number): boolean => {
    setViewport((vp) => zoomAt(vp, viewportCenterScreen(), factor))
    return true
  }

  /**
   * Frames the given content: pans so its center sits at the viewport
   * center, and zooms so the whole box fits with a small margin —
   * magnifying a small selection as readily as it shrinks an oversized
   * canvas, which is the whole point of zoom-to-selection. Never
   * magnifies past 1:1 (a two-word note would otherwise fill the screen)
   * and stays inside the viewport module's own [MIN_ZOOM, MAX_ZOOM].
   */
  const frameContent = (ids?: ReadonlySet<string>) => {
    const bounds = contentBounds(boxes, ids)
    if (bounds === undefined) return false
    const containerSize = containerSizeOf(rootRef.current)
    setViewport((vp) => frameViewport(bounds, containerSize, vp.zoom, FRAME_MARGIN_PX))
    return true
  }

  /** Frames the selection, or everything when nothing is selected. */
  const frameSelection = (): boolean => {
    if (selection === undefined) return frameContent()
    return frameContent(new Set([selection.id, ...extraIds]))
  }

  return { viewport, setViewport, stepZoom, frameContent, frameSelection }
}
