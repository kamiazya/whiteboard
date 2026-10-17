// The largest raster the PNG export will ask resvg for.
//
// resvg allocates the whole target (width x height x 4 bytes) synchronously,
// on the loop that serves every other request, before drawing anything. The
// target's size comes from the document — node geometry is any finite number
// — times the caller's scale, so without a ceiling one board at 1e6px a side
// asks for terabytes and takes the process down for every workspace it keeps.
//
// 16384px a side is eight times a 2048px board, past any screen a PNG is
// read on; 64 Mpx (256MiB of RGBA) bounds the long thin target the side
// limit alone would let through. SVG export has no target and no budget.

/** Pixels per side of the PNG target. */
export const EXPORT_MAX_SIDE_PX = 16_384
/** Pixels in the whole PNG target. */
export const EXPORT_MAX_PIXELS = 64 * 1024 * 1024

/**
 * A PNG export whose target is past the budget — the caller's to shrink, so
 * the route answers 400. Recognised by `name`, which is its contract.
 */
class ExportTooLargeError extends Error {
  override readonly name = 'ExportTooLargeError'
  constructor(
    readonly width: number,
    readonly height: number,
  ) {
    super(
      `the PNG would be ${width}x${height}px; an export is at most ${EXPORT_MAX_SIDE_PX}px a side and ${EXPORT_MAX_PIXELS} pixels — lower scale or export SVG`,
    )
  }
}

const ROOT_SIZE = /^<svg\b[^>]*?\swidth="([^"]+)"[^>]*?\sheight="([^"]+)"/

/**
 * Throws `ExportTooLargeError` when rasterising `svg` at `zoom` would exceed
 * the budget. Read from the root's `width`/`height`, which is what resvg
 * sizes the target from; a root without both is refused too, since resvg
 * would then size it from something this check did not read.
 */
export function refuseOversizedTarget(svg: string, zoom: number): void {
  const match = ROOT_SIZE.exec(svg)
  const width = Math.ceil(Number(match?.[1]) * zoom)
  const height = Math.ceil(Number(match?.[2]) * zoom)
  if (
    !(width <= EXPORT_MAX_SIDE_PX && height <= EXPORT_MAX_SIDE_PX) ||
    width * height > EXPORT_MAX_PIXELS
  ) {
    throw new ExportTooLargeError(width, height)
  }
}
