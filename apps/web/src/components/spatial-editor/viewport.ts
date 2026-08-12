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

export interface Bounds {
  readonly minX: number
  readonly minY: number
  readonly maxX: number
  readonly maxY: number
}

interface IdentifiedBox {
  readonly id: string
  readonly box: BBoxLike
}

/**
 * Union of the given boxes' extents, restricted to `ids` when given.
 * Ignores a box with a non-finite x/y. Undefined signals "nothing to
 * frame" — the no-op callers use to skip a frame/pan action rather than
 * producing NaN/Infinity bounds.
 */
export function contentBounds(
  boxes: readonly IdentifiedBox[],
  ids?: ReadonlySet<string>,
): Bounds | undefined {
  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  for (const { id, box } of boxes) {
    if (ids !== undefined && !ids.has(id)) continue
    if (!Number.isFinite(box.x) || !Number.isFinite(box.y)) continue
    minX = Math.min(minX, box.x)
    minY = Math.min(minY, box.y)
    maxX = Math.max(maxX, box.x + box.width)
    maxY = Math.max(maxY, box.y + box.height)
  }
  if (!Number.isFinite(minX) || !Number.isFinite(minY)) return undefined
  return { minX, minY, maxX, maxY }
}

export interface ContainerSize {
  readonly width: number
  readonly height: number
}

/**
 * Fit-zoom+center viewport that frames `bounds`: pans so its center sits at
 * the container's screen center, and zooms so the whole box fits inside the
 * container minus `marginPx` on every side — magnifying a small selection as
 * readily as it shrinks an oversized canvas. Never magnifies past 1:1 (a
 * two-word note would otherwise fill the screen) and stays inside
 * [MIN_ZOOM, MAX_ZOOM]. `containerSize: null` (root not yet measured) keeps
 * `currentZoom` and still pans, matching this module's other total-by-
 * degradation functions rather than requiring a measured container.
 */
export function frameViewport(
  bounds: Bounds,
  containerSize: ContainerSize | null,
  currentZoom: number,
  marginPx: number,
): Viewport {
  const center =
    containerSize === null
      ? { x: 0, y: 0 }
      : { x: containerSize.width / 2, y: containerSize.height / 2 }
  const contentCenter = { x: (bounds.minX + bounds.maxX) / 2, y: (bounds.minY + bounds.maxY) / 2 }
  const width = Math.max(1, bounds.maxX - bounds.minX)
  const height = Math.max(1, bounds.maxY - bounds.minY)
  let zoom = currentZoom
  if (containerSize !== null) {
    const usableWidth = Math.max(1, containerSize.width - marginPx * 2)
    const usableHeight = Math.max(1, containerSize.height - marginPx * 2)
    zoom = clampZoom(Math.min(1, usableWidth / width, usableHeight / height))
  }
  return {
    zoom,
    x: contentCenter.x - center.x / zoom,
    y: contentCenter.y - center.y / zoom,
  }
}

/**
 * The viewport that pans (keeping zoom) so `box` sits centered on screen —
 * only when it does not already fit. Undefined is the no-op signal:
 * "already visible" (nothing to pan) or `containerSize: null` (root not yet
 * measured, nothing to pan against).
 */
export function panToShowTarget(
  box: BBoxLike,
  viewport: Viewport,
  containerSize: ContainerSize | null,
): Viewport | undefined {
  if (containerSize === null) return undefined
  const topLeft = canvasToScreen({ x: box.x, y: box.y }, viewport)
  const bottomRight = canvasToScreen({ x: box.x + box.width, y: box.y + box.height }, viewport)
  const fits =
    topLeft.x >= 0 &&
    topLeft.y >= 0 &&
    bottomRight.x <= containerSize.width &&
    bottomRight.y <= containerSize.height
  if (fits) return undefined
  const centerX = box.x + box.width / 2
  const centerY = box.y + box.height / 2
  return {
    ...viewport,
    x: centerX - containerSize.width / 2 / viewport.zoom,
    y: centerY - containerSize.height / 2 / viewport.zoom,
  }
}
