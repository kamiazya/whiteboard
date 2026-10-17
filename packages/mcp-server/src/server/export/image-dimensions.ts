// The pixel count an image's own header declares, read without decoding it.
//
// resvg sizes a decoder's buffer from these fields, so they are what an
// export has to bound. Each reader checks its format's signature first:
// bytes of another format than the declared type answer `undefined`, as does
// a header too short or too odd to read — the caller drops what it cannot
// size rather than trusting it to be small.

type Bytes = Uint8Array
type Reader = (bytes: Bytes) => number | undefined

const be16 = (b: Bytes, at: number): number => ((b[at] ?? 0) << 8) | (b[at + 1] ?? 0)
const le16 = (b: Bytes, at: number): number => (b[at] ?? 0) | ((b[at + 1] ?? 0) << 8)
const le24 = (b: Bytes, at: number): number => le16(b, at) | ((b[at + 2] ?? 0) << 16)
const be32 = (b: Bytes, at: number): number => be16(b, at) * 0x10000 + be16(b, at + 2)
const startsWith = (b: Bytes, at: number, text: string): boolean =>
  [...text].every((c, i) => b[at + i] === c.charCodeAt(0))

const area = (width: number, height: number): number | undefined =>
  width > 0 && height > 0 ? width * height : undefined

const png: Reader = (b) =>
  b.length >= 24 && b[0] === 0x89 && startsWith(b, 1, 'PNG\r\n\x1a\n') && startsWith(b, 12, 'IHDR')
    ? area(be32(b, 16), be32(b, 20))
    : undefined

// Start-of-frame markers C0-CF, less DHT (C4), JPG (C8) and DAC (CC).
const isStartOfFrame = (marker: number): boolean =>
  marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc

// Segments a decoder skips by their length before the frame header: APPn,
// DQT, DHT, DAC, DRI, COM. Any other marker there — fill bytes, a standalone
// marker, a scan — is one a decoder might walk differently from this reader,
// so it is unreadable rather than guessed past.
const isSkippable = (marker: number): boolean =>
  (marker >= 0xe0 && marker <= 0xef) || [0xdb, 0xc4, 0xcc, 0xdd, 0xfe].includes(marker)

/** The first frame header's size. */
const jpeg: Reader = (b) => {
  if (b[0] !== 0xff || b[1] !== 0xd8) return undefined
  let at = 2
  while (at + 9 <= b.length && b[at] === 0xff) {
    const marker = b[at + 1] ?? 0
    if (isStartOfFrame(marker)) return area(be16(b, at + 7), be16(b, at + 5))
    if (!isSkippable(marker)) return undefined
    at += 2 + be16(b, at + 2)
  }
  return undefined
}

/** Skips a GIF extension's data sub-blocks, answering the offset after them. */
const afterSubBlocks = (b: Bytes, from: number): number => {
  let at = from
  while (at < b.length && b[at] !== 0) at += 1 + (b[at] ?? 0)
  return at + 1
}

/**
 * The logical screen plus the first frame: a frame may declare more than the
 * screen, and a decoder buffers both.
 */
const gif: Reader = (b) => {
  if (!(startsWith(b, 0, 'GIF87a') || startsWith(b, 0, 'GIF89a'))) return undefined
  const screen = area(le16(b, 6), le16(b, 8))
  const flags = b[10] ?? 0
  let at = 13 + (flags & 0x80 ? 3 * 2 ** ((flags & 7) + 1) : 0)
  while (at < b.length && b[at] === 0x21) at = afterSubBlocks(b, at + 2)
  if (b[at] !== 0x2c || at + 9 > b.length) return undefined
  const frame = area(le16(b, at + 5), le16(b, at + 7))
  return screen === undefined || frame === undefined ? undefined : screen + frame
}

const webp: Reader = (b) => {
  if (!(startsWith(b, 0, 'RIFF') && startsWith(b, 8, 'WEBP')) || b.length < 25) return undefined
  if (startsWith(b, 12, 'VP8X') && b.length >= 30) return area(le24(b, 24) + 1, le24(b, 27) + 1)
  if (startsWith(b, 12, 'VP8L') && b[20] === 0x2f) {
    const bits = le16(b, 21) + le16(b, 23) * 0x10000
    return area((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1)
  }
  if (
    startsWith(b, 12, 'VP8 ') &&
    b.length >= 30 &&
    b[23] === 0x9d &&
    b[24] === 0x01 &&
    b[25] === 0x2a
  ) {
    return area(le16(b, 26) & 0x3fff, le16(b, 28) & 0x3fff)
  }
  return undefined
}

const SVG_ROOT = /<svg\b[^>]*>/
const SVG_LENGTH = /^\s*(\d+(?:\.\d+)?)\s*(?:px)?\s*$/

const svgAttr = (root: string, name: string): string | undefined =>
  new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`).exec(root)?.slice(1).find(Boolean)

/** `width`/`height` in user units, else the `viewBox`'s; a percentage or unit is unreadable. */
const svg: Reader = (b) => {
  const root = SVG_ROOT.exec(new TextDecoder().decode(b))?.[0]
  if (root === undefined) return undefined
  const width = SVG_LENGTH.exec(svgAttr(root, 'width') ?? '')?.[1]
  const height = SVG_LENGTH.exec(svgAttr(root, 'height') ?? '')?.[1]
  if (width !== undefined && height !== undefined) {
    return area(Math.ceil(Number(width)), Math.ceil(Number(height)))
  }
  const box = (svgAttr(root, 'viewBox') ?? '')
    .trim()
    .split(/[\s,]+/)
    .map(Number)
  return box.length === 4 ? area(Math.ceil(box[2] ?? 0), Math.ceil(box[3] ?? 0)) : undefined
}

// The types resvg decodes, and nothing else: a `data:` URL naming another
// type, or none, is one resvg would sniff, and is dropped rather than sized.
const READERS: Readonly<Record<string, Reader>> = {
  'image/png': png,
  'image/jpeg': jpeg,
  'image/jpg': jpeg,
  'image/gif': gif,
  'image/webp': webp,
  'image/svg+xml': svg,
}

/**
 * The pixels an image of `mime` declares in its header, or `undefined` when
 * the type is not one the export draws or the header cannot be read.
 */
export function declaredPixels(mime: string, bytes: Uint8Array): number | undefined {
  return Object.hasOwn(READERS, mime) ? READERS[mime]?.(bytes) : undefined
}
