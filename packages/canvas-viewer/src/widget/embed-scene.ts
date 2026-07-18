// HTML's raw-text parsing rule terminates a <script> element the moment it
// sees the literal byte sequence `</script` (case-insensitively), even when
// that sequence occurs inside a JSON string value rather than real markup.
// A scene whose text content contains `</script>` (or an SGML comment
// opener `<!--`, which some legacy parsers also special-case inside
// <script>) would otherwise close the tag early and let the remainder be
// interpreted as executable HTML.
//
// Escaping every literal less-than character as a JSON unicode escape
// sequence breaks apart both sequences while staying valid JSON — JSON.parse
// decodes the escape back to a literal less-than during hydration in
// mount.ts's readEmbeddedScene, so parsed scene content is unaffected.
export function serializeSceneForScriptTag(scene: unknown): string {
  return JSON.stringify(scene).replace(/</g, '\\u003c')
}
