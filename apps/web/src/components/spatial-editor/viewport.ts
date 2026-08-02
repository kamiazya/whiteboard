/**
 * Pure viewport math for the spatial editor's pan/zoom transform. The
 * viewport is component STATE, never canvas data — no function here reads
 * or writes a `SpatialCanvas`.
 */

export interface Point {
  readonly x: number
  readonly y: number
}

export interface Viewport {
  /** Canvas-space point currently shown at screen-space origin (0, 0). */
  readonly x: number
  readonly y: number
  readonly zoom: number
}

export const MIN_ZOOM = 0.1
export const MAX_ZOOM = 10

export const IDENTITY_VIEWPORT: Viewport = { x: 0, y: 0, zoom: 1 }

/** Clamps to [MIN_ZOOM, MAX_ZOOM], mapping any non-finite input to 1 (identity). */
export function clampZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) return 1
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom))
}

/** Screen-space -> canvas-space, given the current viewport. */
export function screenToCanvas(point: Point, viewport: Viewport): Point {
  return {
    x: point.x / viewport.zoom + viewport.x,
    y: point.y / viewport.zoom + viewport.y,
  }
}

/** Canvas-space -> screen-space, the inverse of screenToCanvas. */
export function canvasToScreen(point: Point, viewport: Viewport): Point {
  return {
    x: (point.x - viewport.x) * viewport.zoom,
    y: (point.y - viewport.y) * viewport.zoom,
  }
}

/**
 * Zooms by `factor` while holding the canvas point currently under
 * `anchorScreenPoint` fixed on screen (the standard "zoom under cursor"
 * behavior). Returns a NEW viewport; never mutates its input.
 */
export function zoomAt(viewport: Viewport, anchorScreenPoint: Point, factor: number): Viewport {
  const nextZoom = clampZoom(viewport.zoom * factor)
  const anchorCanvasPoint = screenToCanvas(anchorScreenPoint, viewport)
  return {
    zoom: nextZoom,
    x: anchorCanvasPoint.x - anchorScreenPoint.x / nextZoom,
    y: anchorCanvasPoint.y - anchorScreenPoint.y / nextZoom,
  }
}

/** Pans by a screen-space delta (e.g. from a wheel or drag event). */
export function panBy(viewport: Viewport, screenDelta: Point): Viewport {
  return {
    ...viewport,
    x: viewport.x - screenDelta.x / viewport.zoom,
    y: viewport.y - screenDelta.y / viewport.zoom,
  }
}

interface BBoxLike {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/**
 * Viewport whose top-left shows the union of the given boxes, at identity
 * zoom (no container size is known here, so this fits POSITION only, not
 * scale). Total: an empty list, or a list whose boxes are all non-finite,
 * degrades to `IDENTITY_VIEWPORT` rather than producing NaN/Infinity.
 */
export function fitViewportToBoxes(boxes: readonly BBoxLike[]): Viewport {
  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  for (const box of boxes) {
    if (!Number.isFinite(box.x) || !Number.isFinite(box.y)) continue
    minX = Math.min(minX, box.x)
    minY = Math.min(minY, box.y)
  }
  if (!Number.isFinite(minX) || !Number.isFinite(minY)) return IDENTITY_VIEWPORT
  return { x: minX, y: minY, zoom: 1 }
}

/** CSS `transform` value placing canvas-space content into screen space. */
export function viewportTransformCss(viewport: Viewport): string {
  return `scale(${viewport.zoom}) translate(${-viewport.x}px, ${-viewport.y}px)`
}
