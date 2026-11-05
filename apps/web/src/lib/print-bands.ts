/** A block's vertical extent, in the preview SVG's own pixel space. */
export interface PrintBlock {
  readonly y: number
  readonly h: number
}

/** One horizontal strip of the drawn body that prints as a unit. */
export interface PrintBand {
  readonly top: number
  readonly bottom: number
}

/**
 * Where a printed body may break across pages: between two of its top-level
 * blocks, never through one. The preview is ONE SVG, and a page break through
 * an SVG slices whatever lies on the line — half a picture, the top of a
 * line of text — so the print view draws the body as one strip per block and
 * lets the page keep each strip whole.
 *
 * Each cut sits halfway through the gap between two blocks, so a strip
 * carries its own share of the spacing and no ink is lost or doubled. The
 * first strip starts at 0 and the last ends at `height`, so the padding the
 * SVG was drawn with survives. Blocks are taken in order of their top; a
 * block that overlaps the one before (nothing lays out that way, but the
 * input is data) joins its strip rather than cutting through it. With no
 * blocks the whole body is one strip.
 */
export function printBands(blocks: readonly PrintBlock[], height: number): readonly PrintBand[] {
  if (!(height > 0)) return []
  const sorted = blocks
    .filter((block) => Number.isFinite(block.y) && Number.isFinite(block.h))
    .slice()
    .sort((a, b) => a.y - b.y)
  const bands: PrintBand[] = []
  let top = 0
  let reach = Number.NEGATIVE_INFINITY
  for (let index = 0; index < sorted.length; index++) {
    const block = sorted[index] as PrintBlock
    reach = Math.max(reach, block.y + block.h)
    const next = sorted[index + 1]
    if (next === undefined || next.y < reach) continue
    const cut = Math.min(height, (reach + next.y) / 2)
    if (cut > top) bands.push({ top, bottom: cut })
    top = cut
  }
  if (height > top) bands.push({ top, bottom: height })
  return bands
}
