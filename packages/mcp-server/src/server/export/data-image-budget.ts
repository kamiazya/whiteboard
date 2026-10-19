import { refuseOversizedImages } from './export-budget.js'
import { withoutExternalImages } from './external-images.js'
import { declaredPixels } from './image-dimensions.js'

const IMAGE_HREF = /(<image\b[^>]*?)\s(?:xlink:)?href="([^"]*)"/g

const NAMED_REFERENCES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
}

/** An attribute value as the XML parser hands it to resvg. */
const unescapeAttribute = (value: string): string =>
  value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, ref: string) => {
    if (ref.startsWith('#')) {
      const code =
        ref[1] === 'x' || ref[1] === 'X' ? Number.parseInt(ref.slice(2), 16) : Number(ref.slice(1))
      return Number.isSafeInteger(code) && code <= 0x10ffff ? String.fromCodePoint(code) : whole
    }
    return NAMED_REFERENCES[ref] ?? whole
  })

// Only the two header shapes whose decoding is unambiguous: `type` and
// `type;base64`. Any other parameter, whitespace, or a character outside the
// alphabet is somewhere this reader and resvg's could disagree on the bytes.
const DATA_URL = /^data:([a-z0-9.+-]+\/[a-z0-9.+-]+)(;base64)?,(.*)$/is
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/
const PERCENT_ENCODED = /^(?:[!-$&-~]|%[\da-f]{2})*$/i

/** The type and bytes of a `data:` URL, or `undefined` when they are ambiguous. */
const decodeDataUrl = (href: string): { mime: string; bytes: Uint8Array } | undefined => {
  const [, mime, base64, body] = DATA_URL.exec(href) ?? []
  if (mime === undefined || body === undefined) return undefined
  if (base64 !== undefined) {
    return BASE64.test(body)
      ? { mime: mime.toLowerCase(), bytes: Buffer.from(body, 'base64') }
      : undefined
  }
  if (!PERCENT_ENCODED.test(body)) return undefined
  const bytes = Buffer.from(
    body.replace(/%([\da-f]{2})/gi, (_, hex: string) =>
      String.fromCharCode(Number.parseInt(hex, 16)),
    ),
    'latin1',
  )
  return { mime: mime.toLowerCase(), bytes }
}

/**
 * SVG text that asks resvg for work its declared size does not bound. A
 * filter is rasterised at device resolution, synchronously: one feMorphology
 * of radius 10 over a 100px image costs 46ms at export scale 1 and 17.7s at
 * scale 8, and every further primitive adds as much again. A mask costs no
 * time but is sized from its CONTENT's bounding box, not the declared root:
 * a root declaring 1x1 masking 1e7px of content, drawn at 1024px, reserves a
 * pixmap the kernel refuses and resvg aborts the whole process
 * (`scripts/measure/nested-svg-filter-cost.mjs`, `maskwide`; patterns and
 * `<use>` fan-out measured flat). So every way of ASKING for either refuses
 * — a `<filter>`, `fe*` or `<mask>` element under any prefix (an XML name,
 * which need not be ASCII, so the prefix class is what a name cannot
 * contain), a `filter` or `mask` attribute or CSS property, `mask-*`
 * longhands included (a comment may sit before its `:`) — read after
 * XML character references are decoded, as does a CSS escape that could
 * spell one, an entity that could expand into one, and a nested `<image>`,
 * which resvg does not draw today, so refusing one costs nothing it would
 * show. The bare word in a label asks for nothing and is kept.
 *
 * The scan reads the bytes as UTF-8. resvg also reads a gzip-compressed
 * (svgz) and a UTF-16 SVG, which this scan cannot see into; those are dropped
 * because the sizer reads its root as UTF-8 too and finds none. Teaching the
 * sizer either encoding means teaching this scan the same one first.
 */
const UNBOUNDED_SVG_WORK =
  /<(?:[^\s<>/:="']+:)?(?:filter\b|fe[a-z]|image\b|mask\b)|\b(?:filter|mask(?:-[a-z]+)*)\s*(?:[:=]|\/\*)|<!entity|\\/i

const asksForUnboundedWork = (mime: string, bytes: Uint8Array): boolean =>
  mime === 'image/svg+xml' &&
  UNBOUNDED_SVG_WORK.test(unescapeAttribute(new TextDecoder().decode(bytes)))

/** The pixels a `data:` href declares, or `undefined` when it cannot be sized. */
const pixelsOf = (href: string): number | undefined => {
  const decoded = decodeDataUrl(unescapeAttribute(href))
  if (decoded === undefined || asksForUnboundedWork(decoded.mime, decoded.bytes)) return undefined
  return declaredPixels(decoded.mime, decoded.bytes)
}

/**
 * The SVG with every image resvg would read from outside it dropped, and
 * every inline `data:` image it could not size dropped too — an unknown type,
 * an unreadable header, an ambiguous encoding, an SVG asking for filter or
 * mask work its size does not bound. Throws `ExportTooLargeError`
 * when the images left declare more pixels between them than the export
 * budget, since resvg decodes each at the size its header declares, on the
 * serving loop, however few bytes encoded it.
 */
export function boundedDataImages(svg: string): string {
  let total = 0
  const bounded = withoutExternalImages(svg).replace(
    IMAGE_HREF,
    (whole, head: string, href: string) => {
      const pixels = pixelsOf(href)
      if (pixels === undefined) return head
      total += pixels
      return whole
    },
  )
  refuseOversizedImages(total)
  return bounded
}
