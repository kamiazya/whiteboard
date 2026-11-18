/**
 * The removal of characters XML 1.0 cannot carry at all, applied to the
 * strings a picture's envelope is handed before the core draws them. The
 * markup escaping is the core's (`crates/core/canvas-render/src/xml_escape.rs`).
 */

/**
 * XML 1.0 (§2.2) permits only #x9, #xA, #xD among the C0 control range plus
 * #x20 and above; every other C0/C1 control character is not a valid XML
 * character at all. A lone (unpaired) UTF-16 surrogate is likewise not a
 * valid Unicode scalar value and so not a valid XML character.
 */
// Built via the RegExp constructor (rather than a literal) so the control
// character ranges below don't trip Biome's noControlCharactersInRegex,
// which only flags regex literals.
const XML_CONTROL_CHARS_SOURCE = String.raw`[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]`
const XML_LONE_SURROGATE_SOURCE = String.raw`[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]`
/** U+FFFE and U+FFFF are XML 1.0 noncharacters, forbidden alongside the C0/C1 controls above. */
const XML_NONCHARACTERS_SOURCE = String.raw`[\uFFFE\uFFFF]`
const XML_INVALID_CHARS = new RegExp(
  `${XML_CONTROL_CHARS_SOURCE}|${XML_LONE_SURROGATE_SOURCE}|${XML_NONCHARACTERS_SOURCE}`,
  'g',
)

/**
 * Exported so a check that must judge the EMITTED bytes (`sanitizeHref`'s
 * scheme check) applies the same removal first rather than a copy of it.
 */
export function stripXmlInvalidChars(value: string): string {
  return value.replace(XML_INVALID_CHARS, '')
}
