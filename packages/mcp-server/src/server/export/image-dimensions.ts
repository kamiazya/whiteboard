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

const SVG_LENGTH = /^\s*(\d+(?:\.\d+)?)\s*(?:px)?\s*$/
const XML_SPACE = /[ \t\r\n]/
const ATTRIBUTE_NAME = /[^ \t\r\n=/>"'<]+/y

/** The offset after the first `close` at or past `from`, or -1 when there is none. */
const after = (text: string, close: string, from: number): number => {
  const at = text.indexOf(close, from)
  return at < 0 ? -1 : at + close.length
}

const skipSpace = (text: string, from: number): number => {
  let at = from
  while (at < text.length && XML_SPACE.test(text[at] ?? '')) at++
  return at
}

const isRootStart = (text: string, at: number): boolean =>
  text.startsWith('<svg', at) && /[ \t\r\n/>]/.test(text[at + 4] ?? '')

/** The offset after the prolog item at `at`, or -1 when it is not one this reader can skip. */
const afterPrologItem = (text: string, at: number): number => {
  if (text.startsWith('<?', at)) return after(text, '?>', at)
  if (text.startsWith('<!--', at)) return after(text, '-->', at)
  if (!text.startsWith('<!DOCTYPE', at)) return -1
  const end = text.indexOf('>', at)
  return end < 0 || text.slice(at, end).includes('[') ? -1 : end + 1
}

/**
 * Where the root `<svg` start tag begins, past the prolog: declarations,
 * comments and processing instructions. Anything else first — another root,
 * a DOCTYPE with an internal subset that could declare entities — is a
 * document this reader and the XML parser might read differently.
 */
const rootStart = (text: string): number | undefined => {
  let at = skipSpace(text, text.charCodeAt(0) === 0xfeff ? 1 : 0)
  while (at < text.length) {
    if (isRootStart(text, at)) return at
    const next = afterPrologItem(text, at)
    if (next < 0) return undefined
    at = skipSpace(text, next)
  }
  return undefined
}

/** The quoted attribute starting at `at`, or `undefined` when it is not well-formed. */
const readAttribute = (
  text: string,
  at: number,
): { name: string; value: string; end: number } | undefined => {
  ATTRIBUTE_NAME.lastIndex = at
  const name = ATTRIBUTE_NAME.exec(text)?.[0]
  if (name === undefined) return undefined
  const equals = skipSpace(text, at + name.length)
  if (text[equals] !== '=') return undefined
  const open = skipSpace(text, equals + 1)
  const quote = text[open]
  if (quote !== '"' && quote !== "'") return undefined
  const close = text.indexOf(quote, open + 1)
  return close < 0 ? undefined : { name, value: text.slice(open + 1, close), end: close + 1 }
}

/**
 * The root element's attributes, tokenised the way an XML parser reads them:
 * a quoted value is one unit, so text inside it never reads as another
 * attribute. A start tag that is not well-formed — an unquoted value, an
 * unterminated quote, a repeated name — answers `undefined`.
 */
const svgRootAttributes = (text: string): ReadonlyMap<string, string> | undefined => {
  const start = rootStart(text)
  if (start === undefined) return undefined
  const attributes = new Map<string, string>()
  let at = start + 4
  for (;;) {
    const spaced = skipSpace(text, at)
    if (text.startsWith('>', spaced) || text.startsWith('/>', spaced)) return attributes
    const attribute = spaced === at ? undefined : readAttribute(text, spaced)
    if (attribute === undefined || attributes.has(attribute.name)) return undefined
    attributes.set(attribute.name, attribute.value)
    at = attribute.end
  }
}

/**
 * `width`/`height` in user units, else — only when neither is given — the
 * `viewBox`'s. An explicit length this reader cannot convert (a percentage,
 * a unit, a value carrying a reference) is unreadable rather than replaced by
 * the viewBox, which resvg would not use in its place.
 */
const svg: Reader = (b) => {
  const root = svgRootAttributes(new TextDecoder().decode(b))
  if (root === undefined) return undefined
  const givenWidth = root.get('width')
  const givenHeight = root.get('height')
  if (givenWidth !== undefined || givenHeight !== undefined) {
    const width = SVG_LENGTH.exec(givenWidth ?? '')?.[1]
    const height = SVG_LENGTH.exec(givenHeight ?? '')?.[1]
    return width === undefined || height === undefined
      ? undefined
      : area(Math.ceil(Number(width)), Math.ceil(Number(height)))
  }
  const box = (root.get('viewBox') ?? '')
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
