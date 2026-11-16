// HTML's raw-text parsing rule terminates a <script> element the moment it
// sees the literal byte sequence `</script` (case-insensitively), even when
// that sequence occurs inside a JSON string value rather than real markup.
// A picture whose SVG contains `</script>` (or an SGML comment
// opener `<!--`, which some legacy parsers also special-case inside
// <script>) would otherwise close the tag early and let the remainder be
// interpreted as executable HTML.
//
// Escaping every literal less-than character as a JSON unicode escape
// sequence breaks apart both sequences while staying valid JSON — JSON.parse
// decodes the escape back to a literal less-than when widget-entry's
// readEmbeddedPicture reads the slot, so the picture is unaffected.
export function serializeForScriptTag(value: unknown): string {
  const json = JSON.stringify(value)
  if (json === undefined) {
    // JSON.stringify returns undefined (not a string) for root undefined,
    // functions, and symbols — fail with a clear contract error instead of
    // a confusing TypeError from .replace on undefined.
    throw new TypeError('serializeForScriptTag requires a JSON-serializable value')
  }
  return json.replace(/</g, '\\u003c')
}
