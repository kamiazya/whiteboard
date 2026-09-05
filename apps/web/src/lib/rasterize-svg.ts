/**
 * An already-serialized SVG as PNG bytes, through an `<img>` + `<canvas>` 2D
 * context.
 *
 * Shared rather than private to the spatial exporter, because the picture a
 * saved point carries is a PNG whichever pipeline drew it: the daemon's
 * upload route validates the signature and rejects anything else, so a
 * markdown body that reached the keeper as an SVG would be refused by one
 * keeper and accepted by the other.
 *
 * Returns null when no real 2D context exists (e.g. jsdom) — that is "format
 * unavailable in this environment", not an error.
 */
export async function rasterizeSvgToPng(
  svg: string,
  width: number,
  height: number,
): Promise<Blob | null> {
  const canvasEl = document.createElement('canvas')
  canvasEl.width = width
  canvasEl.height = height
  const ctx = canvasEl.getContext('2d')
  if (!ctx) return null

  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }))
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image()
      img.onload = () => resolve(img)
      img.onerror = () => reject(new Error('failed to load rasterized SVG'))
      img.src = url
    })
    ctx.drawImage(image, 0, 0, width, height)
  } finally {
    URL.revokeObjectURL(url)
  }
  return new Promise<Blob | null>((resolve) => {
    canvasEl.toBlob(resolve, 'image/png')
  })
}
