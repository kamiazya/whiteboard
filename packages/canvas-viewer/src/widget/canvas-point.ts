/**
 * Maps a click on the widget's rendered SVG to CANVAS coordinates — the
 * anchor a comment stores (ADR-0024).
 *
 * Two render shapes exist and each maps differently:
 *
 * - The widget's default render is the legacy bodyless-root SVG (no
 *   viewBox, no width/height — see canvas-render's decision #5), where one
 *   SVG user unit is one CSS pixel and the origin is the element's own
 *   top-left corner. The offset from the corner IS the canvas point.
 * - A render with a document envelope carries a viewBox; the click maps
 *   linearly through it. ponytail: this branch assumes the CSS box matches
 *   the viewBox's aspect ratio (no preserveAspectRatio letterboxing); solve
 *   with getScreenCTM if an envelope-rendered widget ever ships.
 *
 * Answers `undefined` for a degenerate element (zero-size rect, unparseable
 * viewBox) — a click nobody can map is not an anchor.
 */
export function canvasPointFromClick(
  svg: SVGSVGElement,
  clientX: number,
  clientY: number,
): { readonly x: number; readonly y: number } | undefined {
  const rect = svg.getBoundingClientRect()
  if (!(rect.width > 0) || !(rect.height > 0)) return undefined

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
