/**
 * Source lines <-> laid-out document Y, through the per-block anchors the
 * preview render already reports.
 *
 * Both directions, because the rail needs both: it draws the document's
 * laid-out shape, and in write mode the thing that scrolls is measured in
 * lines. Pure and separate from the editor so the interpolation is testable
 * without a CodeMirror view or a DOM.
 *
 * Interpolation is linear inside the band between two consecutive blocks.
 * Blank separator lines belong to the band ABOVE, so scrolling through them
 * eases toward the next block rather than jumping at its first line.
 */

import type { PreviewBlockAnchor } from './render-preview.js'

export interface AnchorTail {
  /** Lines in the source, so the last band has an end. */
  readonly totalLines: number
  /** The laid-out document's height, so the last band has a Y to reach. */
  readonly contentHeight: number
}

function bandIndex(
  anchors: readonly PreviewBlockAnchor[],
  matches: (anchor: PreviewBlockAnchor) => boolean,
): number {
  let index = anchors.length - 1
  while (index > 0 && !matches(anchors[index] as PreviewBlockAnchor)) index--
  return index
}

export function documentYForLine(
  anchors: readonly PreviewBlockAnchor[],
  line: number,
  { totalLines, contentHeight }: AnchorTail,
): number {
  const first = anchors[0]
  if (first === undefined) return 0
  // Above the first block: ease in proportionally rather than pinning to 0,
  // so scrolling through a leading blank line still moves the marker.
  if (line <= first.line) {
    return first.line > 0 ? first.y * Math.max(0, line / first.line) : 0
  }
  const index = bandIndex(anchors, (anchor) => anchor.line <= line)
  const current = anchors[index] as PreviewBlockAnchor
  const next = anchors[index + 1]
  const endLine = next?.line ?? totalLines + 1
  const endY = next?.y ?? contentHeight
  const span = Math.max(1, endLine - current.line)
  const t = Math.min(1, Math.max(0, (line - current.line) / span))
  return current.y + t * (endY - current.y)
}

export function lineForDocumentY(
  anchors: readonly PreviewBlockAnchor[],
  y: number,
  { totalLines, contentHeight }: AnchorTail,
): number {
  const first = anchors[0]
  if (first === undefined) return 1
  if (y <= first.y) {
    return first.y > 0 ? Math.max(1, first.line * (y / first.y)) : first.line
  }
  const index = bandIndex(anchors, (anchor) => anchor.y <= y)
  const current = anchors[index] as PreviewBlockAnchor
  const next = anchors[index + 1]
  const endLine = next?.line ?? totalLines
  const endY = next?.y ?? contentHeight
  // A zero-height band (an empty block laid out at its neighbour's Y) would
  // otherwise divide by zero and answer NaN.
  const span = endY - current.y
  if (span <= 0) return current.line
  const t = Math.min(1, Math.max(0, (y - current.y) / span))
  return Math.min(totalLines, current.line + t * (endLine - current.line))
}
