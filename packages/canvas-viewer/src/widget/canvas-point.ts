/**
 * Maps a click on the widget's rendered SVG to CANVAS coordinates — the
 * anchor a comment stores (ADR-0024).
 *
 * Through the element's screen matrix where the realm has one: the picture
 * is scaled to the widget's frame with its proportions kept, so it can sit
 * letterboxed inside its box, and only the matrix knows where the drawing
 * itself starts. Without one (jsdom), a viewBox maps linearly over the
 * element's box, and a root with no viewBox is one CSS pixel per unit from
 * the element's own corner.
 *
 * Answers `undefined` for a degenerate element (a rect with no positive width
 * and height) — a click nobody can map is not an anchor. An unparseable
 * viewBox is not that: the click still landed inside a sized element, so it
 * reads as the bodyless-root shape rather than being dropped.
 */
export function canvasPointFromClick(
  svg: SVGSVGElement,
  clientX: number,
  clientY: number,
): { readonly x: number; readonly y: number } | undefined {
  const rect = svg.getBoundingClientRect()
  if (!(rect.width > 0) || !(rect.height > 0)) return undefined
  const matrix = typeof svg.getScreenCTM === 'function' ? svg.getScreenCTM() : null
  if (matrix !== null) {
    const point = new DOMPoint(clientX, clientY).matrixTransform(matrix.inverse())
    return { x: Math.round(point.x), y: Math.round(point.y) }
  }

  const viewBox = parseViewBox(svg.getAttribute('viewBox'))
  if (viewBox === undefined) {
    return { x: Math.round(clientX - rect.left), y: Math.round(clientY - rect.top) }
  }
  return {
    x: Math.round(viewBox.x + ((clientX - rect.left) / rect.width) * viewBox.w),
    y: Math.round(viewBox.y + ((clientY - rect.top) / rect.height) * viewBox.h),
  }
}

function parseViewBox(
  raw: string | null,
): { x: number; y: number; w: number; h: number } | undefined {
  if (raw === null) return undefined
  const parts = raw
    .trim()
    .split(/[\s,]+/)
    .map(Number)
  if (parts.length !== 4 || parts.some((value) => !Number.isFinite(value))) return undefined
  const [x, y, w, h] = parts as [number, number, number, number]
  if (!(w > 0) || !(h > 0)) return undefined
  return { x, y, w, h }
}
