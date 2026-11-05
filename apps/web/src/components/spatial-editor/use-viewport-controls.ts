// The pan/zoom viewport state and its keyboard-facing controls, extracted
// from SpatialEditor. The math lives in viewport.ts (pure, purity-scanned);
// this hook owns the one `viewport` React state and the frame/zoom verbs
// built over it. Pointer-driven navigation (wheel, hand pan, pinch) stays
// with the pointer wiring in the editor — those handlers read gesture refs
// this hook has no business holding — but they drive the same setViewport
// returned here, so there is exactly one viewport.

import { useEffect, useRef, useState } from 'react'
import type { NodeBox } from '../../lib/spatial/geometry.js'
import {
  anyBoxVisible,
  type ContainerSize,
  contentBounds,
  frameViewport,
  type Point,
  panToShowTarget,
  type Viewport,
  type ViewportOcclusion,
  visibleSize,
  zoomAt,
} from '../../lib/spatial/viewport.js'
import { insetsClearingCorners, sameInsets } from '../../lib/spatial/viewport-insets.js'
import { DOCK_OCCLUSION_PX } from './ToolPalette.js'
import { initialViewport, useRememberViewport } from './use-viewport-memory.js'
import { useVisibleInsets } from './use-visible-insets.js'

/** Margin around framed content, in screen px. */
const FRAME_MARGIN_PX = 24

/**
 * Screen px a framed top row needs above it for the tool chip a selection
 * draws there — a 44px touch slot and its 6px gap. Framed flush, the chip of
 * a selected top row sat under the page header, out of reach.
 */
const NODE_TOOLS_CLEARANCE_PX = 50

/**
 * The insets a framing verb fits content inside: the panels over the root,
 * plus the dock floating over its bottom edge and room for the selection's
 * tool chip along its top.
 */
function framingInsets(insets: ViewportOcclusion): Required<ViewportOcclusion> {
  return {
    top: Math.max(NODE_TOOLS_CLEARANCE_PX, insets.top ?? 0),
    bottom: Math.max(DOCK_OCCLUSION_PX, insets.bottom ?? 0),
    left: insets.left ?? 0,
    right: insets.right ?? 0,
  }
}

/** Cards floating in a corner of the root (`data-viewport-corner`, the overview map), root-local. */
function cornerCards(
  root: HTMLElement,
): { left: number; top: number; right: number; bottom: number }[] {
  const at = root.getBoundingClientRect()
  return [...root.querySelectorAll<HTMLElement>('[data-viewport-corner]')].map((card) => {
    const r = card.getBoundingClientRect()
    return {
      left: r.left - at.left,
      top: r.top - at.top,
      right: r.right - at.left,
      bottom: r.bottom - at.top,
    }
  })
}

/**
 * Frames `bounds` inside the framing insets — and, when that would put one of
 * the framed `boxes` under a corner card, frames it again clear of the card.
 * Only then: a lone note fitted to the middle stays in the middle.
 */
function frameClearOfCorners(
  bounds: NonNullable<ReturnType<typeof contentBounds>>,
  boxes: readonly NodeBox[],
  size: ContainerSize | null,
  zoom: number,
  insets: ViewportOcclusion,
  root: HTMLElement | null,
): Viewport {
  const base = framingInsets(insets)
  const plain = frameViewport(bounds, size, zoom, FRAME_MARGIN_PX, base)
  const cards = root === null || size === null ? [] : cornerCards(root)
  const under = boxes.some(({ box }) => {
    const left = (box.x - plain.x) * plain.zoom
    const top = (box.y - plain.y) * plain.zoom
    const right = left + box.width * plain.zoom
    const bottom = top + box.height * plain.zoom
    return cards.some((c) => left < c.right && c.left < right && top < c.bottom && c.top < bottom)
  })
  if (!under || size === null) return plain
  const rootRect = { left: 0, top: 0, right: size.width, bottom: size.height }
  return frameViewport(
    bounds,
    size,
    zoom,
    FRAME_MARGIN_PX,
    insetsClearingCorners(rootRect, cards, base),
  )
}

export interface ViewportControlsInputs {
  rootRef: { current: HTMLDivElement | null }
  boxes: readonly NodeBox[]
  /** The primary selection, when one exists (frameSelection frames it + extras). */
  selection: { id: string } | undefined
  extraIds: ReadonlySet<string>
  viewportCenterScreen: () => Point
  containerSizeOf: (root: HTMLDivElement | null) => ContainerSize | null
  /** Identity of the document, to remember where it was last looked at; omitted = forget. */
  memoryKey?: string | undefined
}

/**
 * A document opens on its content, not on the origin: a diagram drawn around
 * large coordinates (the centre of a fitted or panned view), or a remembered
 * position the content has since left, would otherwise open on blank paper. Decided once
 * per run of non-empty boxes — the arming resets when the boxes empty, which
 * is how a different document arrives — and only while the container is
 * measurable. A viewport that already shows some content is never moved.
 */
function useOpenOnContent({
  rootRef,
  boxes,
  containerSizeOf,
  insetsOf,
  viewport,
  setViewport,
}: Pick<ViewportControlsInputs, 'rootRef' | 'boxes' | 'containerSizeOf'> & {
  insetsOf: () => ViewportOcclusion
  viewport: Viewport
  setViewport: (next: Viewport) => void
}) {
  const openedRef = useRef(false)
  useEffect(() => {
    if (boxes.length === 0) {
      openedRef.current = false
      return
    }
    if (openedRef.current) return
    const size = containerSizeOf(rootRef.current)
    if (size === null || size.width <= 0 || size.height <= 0) return
    openedRef.current = true
    const insets = insetsOf()
    // Visible means in the part no panel covers: the strip it hides is as
    // blank as paper past the edge.
    const shifted = {
      ...viewport,
      x: viewport.x - (insets.left ?? 0) / viewport.zoom,
      y: viewport.y - (insets.top ?? 0) / viewport.zoom,
    }
    if (anyBoxVisible(boxes, shifted, visibleSize(size, insets))) return
    const bounds = contentBounds(boxes)
    if (bounds === undefined) return
    setViewport(frameClearOfCorners(bounds, boxes, size, viewport.zoom, insets, rootRef.current))
  })
}

/**
 * Keeps the selected node in view when the canvas is resized. The facet
 * panel (and any other column taken out of the canvas) shrinks the root, and
 * a node that sat in the column it took is then styled blind; the least pan
 * that shows it again is the medium's own answer, and a node already visible
 * is not moved. The first measurement only records the size: a root that was
 * never measured has nothing to pan against.
 */
function useKeepSelectionInView({
  rootRef,
  boxes,
  selection,
  containerSizeOf,
  insetsOf,
  viewport,
  setViewport,
}: Pick<ViewportControlsInputs, 'rootRef' | 'boxes' | 'selection' | 'containerSizeOf'> & {
  insetsOf: () => ViewportOcclusion
  viewport: Viewport
  setViewport: (next: Viewport) => void
}) {
  const lastRef = useRef<{ size: ContainerSize; insets: ViewportOcclusion } | null>(null)
  useEffect(() => {
    const size = containerSizeOf(rootRef.current)
    const insets = insetsOf()
    const last = lastRef.current
    lastRef.current = size === null ? null : { size, insets }
    if (size === null || last === null) return
    const unchanged =
      last.size.width === size.width &&
      last.size.height === size.height &&
      sameInsets(last.insets, insets)
    if (unchanged) return
    const box = boxes.find((candidate) => candidate.id === selection?.id)
    if (box === undefined) return
    const next = panToShowTarget(box.box, viewport, size, insets)
    if (next !== undefined) setViewport(next)
  })
}

/** Where the viewport settles on its own: on open, and when a panel or resize hides the selection. */
function usePlacement(inputs: Parameters<typeof useKeepSelectionInView>[0]) {
  useOpenOnContent(inputs)
  useKeepSelectionInView(inputs)
}

export function useViewportControls({
  rootRef,
  boxes,
  selection,
  extraIds,
  viewportCenterScreen,
  containerSizeOf,
  memoryKey,
}: ViewportControlsInputs) {
  const [viewport, setViewport] = useState<Viewport>(() => initialViewport(memoryKey))
  useRememberViewport(memoryKey, viewport)
  // Panels over the root are padding for every verb below and for the comment reveal.
  const { insetsOf } = useVisibleInsets(rootRef)

  usePlacement({ rootRef, boxes, selection, containerSizeOf, insetsOf, viewport, setViewport })

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
    const insets = insetsOf()
    const framed = ids === undefined ? boxes : boxes.filter(({ id }) => ids.has(id))
    setViewport((vp) =>
      frameClearOfCorners(bounds, framed, containerSize, vp.zoom, insets, rootRef.current),
    )
    return true
  }

  /** Frames the selection, or everything when nothing is selected. */
  const frameSelection = (): boolean => {
    if (selection === undefined) return frameContent()
    return frameContent(new Set([selection.id, ...extraIds]))
  }

  return { viewport, setViewport, stepZoom, frameContent, frameSelection, insetsOf }
}
