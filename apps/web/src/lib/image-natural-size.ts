/** A decoded picture's natural size, in px. */
export interface ImageSize {
  readonly width: number
  readonly height: number
}

/**
 * The natural size of the picture at `href`, or `undefined` when it does not
 * decode (or this realm cannot decode one). The layout is synchronous and
 * cannot learn a picture's shape, so a caller that wants a body's
 * stand-alone picture drawn at its own size decodes it first and passes the
 * size beside the href.
 */
export async function decodeNaturalSize(href: string): Promise<ImageSize | undefined> {
  if (typeof Image === 'undefined') return undefined
  try {
    const image = new Image()
    image.src = href
    await image.decode()
    const { naturalWidth: width, naturalHeight: height } = image
    return width > 0 && height > 0 ? { width, height } : undefined
  } catch {
    return undefined
  }
}
