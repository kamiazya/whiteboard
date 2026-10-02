import type { RailBlock } from '../../lib/rail-geometry.js'
import type { PreviewBlockAnchor } from '../../lib/render-preview.js'
import type { SourcePaneApi } from './SourcePane.js'

/** The laid-out document's height — the last block's bottom edge. */
export function railContentHeight(blocks: readonly RailBlock[]): number {
  let bottom = 0
  for (const block of blocks) bottom = Math.max(bottom, block.y + block.h)
  return bottom
}

export function totalSourceLines(value: string): number {
  return value.split('\n').length
}

/**
 * The preview DOCUMENT's own SVG — the laid-out markdown — and not merely
 * the first SVG inside the preview column.
 *
 * Four places measure their origin from it, and a bare `querySelector('svg')`
 * answers all four wrongly the moment a document has a conversation on it:
 * the comment markers live in that same column, each carries an icon, and
 * they are rendered BEFORE the pane. Measured — the query returned a marker's
 * own `viewBox="0 0 24 24"` icon, so the marker placement was reading its own
 * previous output as its origin and computed a `svgTop` of 165 where the
 * document's is 32.
 *
 * Scoped by the pane's own class rather than by DOM order, so the next
 * element added to this column cannot bring it back.
 */
export function previewDocumentSvg(within: Element | null | undefined): SVGElement | null {
  const found = within?.querySelector('.markdown-preview-pane svg') ?? null
  return found instanceof SVGElement ? found : null
}

/**
 * Maps the top visible source line onto a preview scrollTop through the
 * per-block anchors, interpolating linearly inside the band between two
 * consecutive blocks (blank separator lines belong to the band above, so
 * scrolling through them eases toward the next block instead of jumping).
 * `undefined` means the anchored path cannot answer — no anchors yet, no
 * source API, no rendered SVG — and the caller keeps its proportional
 * fallback.
 */
function anchoredPreviewTop(
  anchors: readonly PreviewBlockAnchor[],
  api: SourcePaneApi | null,
  preview: HTMLElement,
  totalLines: number,
): number | undefined {
  const first = anchors[0]
  if (first === undefined || api === null || typeof api.topVisibleLine !== 'function') {
    return undefined
  }
  const svg = previewDocumentSvg(preview)
  if (svg === null) return undefined
  const line = api.topVisibleLine()
  // The SVG's own offset inside the scroll content (the document column
  // wrapper adds padding above it), measured live so pane resizes and
  // header changes never go stale.
  const svgTop =
    svg.getBoundingClientRect().top - preview.getBoundingClientRect().top + preview.scrollTop
  if (line <= first.line) return svgTop + first.y * Math.max(0, line / first.line)
  let index = anchors.length - 1
  while (index > 0 && (anchors[index]?.line ?? Number.POSITIVE_INFINITY) > line) index--
  const current = anchors[index]
  if (current === undefined) return undefined
  const next = anchors[index + 1]
  const bandEndLine = next?.line ?? totalLines + 1
  const bandEndY = next?.y ?? svg.getBoundingClientRect().height
  const span = Math.max(1, bandEndLine - current.line)
  const t = Math.min(1, Math.max(0, (line - current.line) / span))
  return svgTop + current.y + t * (bandEndY - current.y)
}

/**
 * The preview scrollTop that shows what the source is showing: through the
 * per-block anchors when they can answer, otherwise the same proportion of
 * each pane's scroll range. `undefined` when neither pane can scroll.
 */
export function followingPreviewTop(
  scroller: HTMLElement,
  preview: HTMLElement,
  anchors: readonly PreviewBlockAnchor[],
  api: SourcePaneApi | null,
  totalLines: number,
): number | undefined {
  const anchored = anchoredPreviewTop(anchors, api, preview, totalLines)
  if (anchored !== undefined) return anchored
  const sourceRange = scroller.scrollHeight - scroller.clientHeight
  const previewRange = preview.scrollHeight - preview.clientHeight
  if (sourceRange <= 0 || previewRange <= 0) return undefined
  return (scroller.scrollTop / sourceRange) * previewRange
}

/**
 * The preview scrollTop that centres a laid-out document position, the way
 * a minimap press does — landing it at the very top would hide the context
 * just above it.
 */
export function centredPreviewTop(preview: HTMLElement, documentY: number): number {
  const svg = previewDocumentSvg(preview)
  const svgTop =
    svg === null
      ? 0
      : svg.getBoundingClientRect().top - preview.getBoundingClientRect().top + preview.scrollTop
  return svgTop + documentY - preview.clientHeight / 2
}
