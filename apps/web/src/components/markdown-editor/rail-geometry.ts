/**
 * The geometry behind the editor's right-hand rail — a whole-document map
 * that doubles as the scrollbar.
 *
 * Pure, and separate from the component, for the same reason the spatial
 * editor's `minimap.ts` is: the arithmetic is where the off-by-one lives,
 * and it is testable without a DOM.
 *
 * The rail shows the ENTIRE document compressed to fit, rather than a
 * 1:1 slice that scrolls independently. A map you also have to scroll is
 * a second navigation problem, and the rail exists to remove one.
 */

/** A block's box in document coordinates — what `outlineFromScene` emits. */
export interface RailBlock {
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
}

export interface RailRow {
  readonly top: number
  readonly height: number
  readonly left: number
  readonly width: number
}

export interface RailGeometry {
  /** Document px -> rail px. Never above 1: a short document is not magnified. */
  readonly scale: number
  readonly railHeight: number
  readonly contentHeight: number
  readonly rows: readonly RailRow[]
}

/** Below this a row is invisible, and the outline exists to say something is there. */
const MIN_ROW_PX = 1

export function railGeometry(
  blocks: readonly RailBlock[],
  { railHeight, railWidth }: { railHeight: number; railWidth: number },
): RailGeometry {
  const empty: RailGeometry = { scale: 1, railHeight, contentHeight: 0, rows: [] }
  if (!Number.isFinite(railHeight) || railHeight <= 0) return { ...empty, rows: [] }
  if (blocks.length === 0) return empty

  const contentHeight = Math.max(...blocks.map((block) => block.y + block.h))
  const widest = Math.max(...blocks.map((block) => block.w))
  if (!Number.isFinite(contentHeight) || contentHeight <= 0) return empty

  // Capped at 1: a document shorter than the rail sits at its natural size
  // rather than being stretched into a shape it does not have.
  const scale = Math.min(1, railHeight / contentHeight)
  // Widths are scaled independently of heights — the rail is a fixed narrow
  // column, so preserving the document's aspect ratio would leave every row
  // hairline-thin. What has to survive is RELATIVE width: a column of equal
  // bars tells the reader nothing about the document.
  const widthScale = widest > 0 ? railWidth / widest : 0

  return {
    scale,
    railHeight,
    contentHeight,
    rows: blocks.map((block) => ({
      top: block.y * scale,
      height: Math.max(MIN_ROW_PX, block.h * scale),
      left: 0,
      width: block.w * widthScale,
    })),
  }
}

/** Where a press at `offset` down the rail points, in document coordinates. */
export function railOffsetToDocumentY(offset: number, geometry: RailGeometry): number {
  if (geometry.scale <= 0) return 0
  const y = offset / geometry.scale
  return Math.min(geometry.contentHeight, Math.max(0, y))
}

/**
 * The visible slice, marked on the rail. Clamped to the rail's own extent:
 * a frame running past the end reads as document that is not there.
 */
export function viewportFrame(
  viewport: { top: number; height: number },
  geometry: RailGeometry,
): { top: number; height: number } {
  const top = Math.min(geometry.railHeight, Math.max(0, viewport.top * geometry.scale))
  const height = Math.max(
    MIN_ROW_PX,
    Math.min(geometry.railHeight - top, viewport.height * geometry.scale),
  )
  return { top, height }
}
