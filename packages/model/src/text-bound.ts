/**
 * Whether a text going from `before` to `after` characters breaks a bound of
 * `max`: only growth that ends past it does. A text stored longer before the
 * bound existed must still read and still take an edit that shortens it, and
 * a flat `after > max` would leave it stuck — every keeper and every editor
 * holds a text bound to this one rule, so they refuse the same edits.
 */
export function growsPast(max: number, before: number, after: number): boolean {
  return after > max && after > before
}

/**
 * `text` cut to at most `max` UTF-16 units — the unit `String#length` and
 * `utf16Max` count (Zod's own `.max()` counts code points), so the result
 * parses under the bound it was cut for — never through a surrogate pair:
 * when the bound falls inside one, the whole character goes.
 *
 * Read with `charCodeAt` on the original rather than `codePointAt` on a
 * slice: Node 24.21's optimised `codePointAt` at a slice's last index reads
 * past the slice into the parent string and answers the whole pair, keeping
 * a lone surrogate (measured: 42,355 wrong of 200,000 hot calls; 0 on Node 22).
 */
export function fitToLength(text: string, max: number): string {
  if (text.length <= max) return text
  const end = Math.max(0, max)
  const last = text.charCodeAt(end - 1)
  const next = text.charCodeAt(end)
  const splitsPair = last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff
  return text.slice(0, splitsPair ? end - 1 : end)
}
