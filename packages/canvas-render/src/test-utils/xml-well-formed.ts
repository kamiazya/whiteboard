/**
 * Minimal test-only XML well-formedness checker: tag-stack balance plus a
 * check that no raw, un-escaped `&`, `<`, or `>` slips through as text
 * content. Not a general-purpose XML parser (no CDATA/PI/DOCTYPE support) —
 * scoped to what this package's SVG backend ever emits.
 */
export function isWellFormedXmlFragment(xml: string): boolean {
  const tagPattern = /<(\/?)([a-zA-Z_][\w:-]*)((?:\s+[a-zA-Z_:][\w:.-]*\s*=\s*"[^"]*")*)\s*(\/?)>/g
  const stack: string[] = []
  let lastIndex = 0
  let match: RegExpExecArray | null = tagPattern.exec(xml)

  while (match !== null) {
    const between = xml.slice(lastIndex, match.index)
    if (hasUnescapedXmlSpecials(between)) return false

    const [, closing, name, , selfClose] = match
    if (closing) {
      if (stack.pop() !== name) return false
    } else if (!selfClose) {
      stack.push(name)
    }

    lastIndex = tagPattern.lastIndex
    match = tagPattern.exec(xml)
  }

  const tail = xml.slice(lastIndex)
  if (hasUnescapedXmlSpecials(tail)) return false
  return stack.length === 0
}

function hasUnescapedXmlSpecials(text: string): boolean {
  if (/[<>]/.test(text)) return true
  return /&(?!amp;|lt;|gt;|quot;|apos;|#\d+;|#x[0-9a-fA-F]+;)/.test(text)
}
