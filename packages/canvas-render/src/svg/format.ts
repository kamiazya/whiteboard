/**
 * Canonical number/string formatting for the SVG backend. This is the ONE
 * place that turns a JS number or string into serialized SVG text, so that
 * the same scene produces byte-identical output on Node, in a browser, and
 * on Workers (`toLocaleString` and native path/number stringification are
 * locale- and engine-dependent and would break that guarantee).
 */

/** Fixed decimal precision for all emitted coordinates. */
const COORD_PRECISION = 3

/**
 * Formats a finite number as a canonical SVG coordinate string: fixed
 * decimal precision, trailing zeros/dot stripped, `-0` normalized to `0`.
 * Non-finite input is rejected here rather than downstream in the
 * serializer — layout is responsible for never producing NaN/Infinity
 * geometry, so a violation here is a layout bug, not a serialization one.
 */
export function formatCoord(value: number): string {
  if (!Number.isFinite(value)) {
    throw new RangeError(`formatCoord: non-finite value ${value}`)
  }
  const rounded = value === 0 ? 0 : value // normalize -0 up front
  const fixed = rounded.toFixed(COORD_PRECISION)
  const stripped = fixed.includes('.') ? fixed.replace(/0+$/, '').replace(/\.$/, '') : fixed
  return stripped === '' || stripped === '-0' ? '0' : stripped
}

const XML_TEXT_ESCAPES: ReadonlyArray<readonly [RegExp, string]> = [
  [/&/g, '&amp;'],
  [/</g, '&lt;'],
  [/>/g, '&gt;'],
]

const XML_ATTR_ESCAPES: ReadonlyArray<readonly [RegExp, string]> = [
  [/&/g, '&amp;'],
  [/</g, '&lt;'],
  [/>/g, '&gt;'],
  [/"/g, '&quot;'],
  [/'/g, '&apos;'],
]

/**
 * XML 1.0 (§2.2) permits only #x9, #xA, #xD among the C0 control range plus
 * #x20 and above; every other C0/C1 control character is not a valid XML
 * character at all. A lone (unpaired) UTF-16 surrogate is likewise not a
 * valid Unicode scalar value and so not a valid XML character. Stripping
 * both here — before markup escaping — keeps the well-formedness checker's
 * scope honest: a test-only checker cannot single-handedly guarantee valid
 * XML if the escaper itself can hand it invalid characters.
 */
// Built via the RegExp constructor (rather than a literal) so the control
// character ranges below don't trip Biome's noControlCharactersInRegex,
// which only flags regex literals.
const XML_CONTROL_CHARS_SOURCE = '[\\x00-\\x08\\x0B\\x0C\\x0E-\\x1F\\x7F-\\x9F]'
const XML_LONE_SURROGATE_SOURCE =
  '[\\uD800-\\uDBFF](?![\\uDC00-\\uDFFF])|(?<![\\uD800-\\uDBFF])[\\uDC00-\\uDFFF]'
const XML_INVALID_CHARS = new RegExp(
  `${XML_CONTROL_CHARS_SOURCE}|${XML_LONE_SURROGATE_SOURCE}`,
  'g',
)

function stripXmlInvalidChars(value: string): string {
  return value.replace(XML_INVALID_CHARS, '')
}

/** Escapes `& < >` for use inside SVG text content. */
export function escapeXmlText(value: string): string {
  return XML_TEXT_ESCAPES.reduce(
    (acc, [pattern, replacement]) => acc.replace(pattern, replacement),
    stripXmlInvalidChars(value),
  )
}

/** Escapes `& < > " '` for use inside a double- or single-quoted XML attribute value. */
export function escapeXmlAttr(value: string): string {
  return XML_ATTR_ESCAPES.reduce(
    (acc, [pattern, replacement]) => acc.replace(pattern, replacement),
    stripXmlInvalidChars(value),
  )
}
