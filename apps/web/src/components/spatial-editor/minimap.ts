/**
 * Minimap geometry: fitting the canvas into a small overview box.
 *
 * Pure and total, like `snap.ts` and `align.ts` — no DOM, no viewport object,
 * no React. The caller supplies the content boxes, the visible canvas rect,
 * and the minimap's own size; it gets back one transform to project either
 * into minimap space.
 */

export interface MinimapBox {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

export interface MinimapFit {
  /** Canvas units -> minimap units. Always finite and > 0. */
  readonly scale: number
  /** Canvas-space point that lands at the minimap's own origin. */
  readonly originX: number
  readonly originY: number
}

/** Fallback extent for a canvas with no area, so `scale` is never 0 or NaN. */
const MIN_EXTENT = 1

function finite(box: MinimapBox): boolean {
  return (
    Number.isFinite(box.x) &&
    Number.isFinite(box.y) &&
    Number.isFinite(box.width) &&
    Number.isFinite(box.height)
  )
}

/**
 * The transform placing `content` AND `viewportRect` inside a `size` box.
 *
 * The viewport is part of the fitted bounds on purpose: fitting content alone
 * would push the "you are here" marker outside the minimap the moment someone
 * pans away from their nodes, which is exactly when an overview is most
 * wanted.
 *
 * Never scales ABOVE 1. Magnifying a two-node canvas to fill the box would
 * make the overview lie about how much room the content occupies.
 */
export function fitMinimap(
  content: readonly MinimapBox[],
  viewportRect: MinimapBox,
  size: { readonly width: number; readonly height: number },
  padding: number,
): MinimapFit {
  const boxes = [...content, viewportRect].filter(finite)
  const safePadding =
    Number.isFinite(padding) && padding > 0
      ? // Padding that would consume the whole box is treated as none: a
        // negative drawable area has no sensible fit, and silently inverting
        // it would put content outside the minimap.
        Math.min(padding, Math.max(0, Math.min(size.width, size.height) / 2 - MIN_EXTENT))
      : 0
  const drawable = {
    width: Math.max(MIN_EXTENT, (Number.isFinite(size.width) ? size.width : 0) - safePadding * 2),
    height: Math.max(
      MIN_EXTENT,
      (Number.isFinite(size.height) ? size.height : 0) - safePadding * 2,
    ),
  }

  if (boxes.length === 0) return { scale: 1, originX: -safePadding, originY: -safePadding }

  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  for (const box of boxes) {
    minX = Math.min(minX, box.x)
    minY = Math.min(minY, box.y)
    maxX = Math.max(maxX, box.x + box.width)
    maxY = Math.max(maxY, box.y + box.height)
  }
  const spanX = Math.max(MIN_EXTENT, maxX - minX)
  const spanY = Math.max(MIN_EXTENT, maxY - minY)

  const scale = Math.min(1, drawable.width / spanX, drawable.height / spanY)
  // Centre the leftover slack, so a canvas that is wide-but-short sits in the
  // middle of the box rather than pinned to a corner.
  const slackX = (drawable.width - spanX * scale) / 2
  const slackY = (drawable.height - spanY * scale) / 2
  return {
    scale,
    originX: minX - (safePadding + slackX) / scale,
    originY: minY - (safePadding + slackY) / scale,
  }
}

/** Projects a canvas-space box into minimap space. */
export function projectBox(box: MinimapBox, fit: MinimapFit): MinimapBox {
  return {
    x: (box.x - fit.originX) * fit.scale,
    y: (box.y - fit.originY) * fit.scale,
    width: box.width * fit.scale,
    height: box.height * fit.scale,
  }
}

/** The canvas-space point under a minimap-space point — for click-to-navigate. */
export function unprojectPoint(
  point: { readonly x: number; readonly y: number },
  fit: MinimapFit,
): { x: number; y: number } {
  return { x: point.x / fit.scale + fit.originX, y: point.y / fit.scale + fit.originY }
}
