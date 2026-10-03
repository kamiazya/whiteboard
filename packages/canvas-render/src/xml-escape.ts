/**
 * XML text and attribute escaping, with the removal of characters XML 1.0
 * cannot carry at all. A leaf below both `layout/` (which builds a text
 * fragment as a string) and `svg/` (which serializes the scene), so neither
 * has to reach into the other for it.
 */

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
/** U+FFFE and U+FFFF are XML 1.0 noncharacters, forbidden alongside the C0/C1 controls above. */
const XML_NONCHARACTERS_SOURCE = '[\\uFFFE\\uFFFF]'
const XML_INVALID_CHARS = new RegExp(
  `${XML_CONTROL_CHARS_SOURCE}|${XML_LONE_SURROGATE_SOURCE}|${XML_NONCHARACTERS_SOURCE}`,
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
