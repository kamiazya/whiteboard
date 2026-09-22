/**
 * The reference GRAMMAR, shared by the two consumers that must agree on it:
 * `resolveReferences` (turning matches into mdast wikiLink/embed nodes for
 * rendering) and reference indexing (finding which documents a body points
 * at). One scanner, or the index would report links the reader never draws.
 */
export interface ReferenceMatch {
  /** Index of the match start (the `!` when present, otherwise the first `[`). */
  index: number
  /** Full matched text, e.g. `[[ID]]` or `![[target|alias]]`. */
  full: string
  isEmbed: boolean
  /** The document half of the address — what resolves to a documentId. */
  target: string
  alias: string | undefined
  /**
   * The `#...` half, when written: a secondary resource inside the target
   * (RFC 3986 §3.5's sense), such as a heading or a canvas group's label.
   * Split at the FIRST `#`, so a fragment may itself contain one. An empty
   * fragment (`[[path#]]`) is the same as none.
   */
  fragment: string | undefined
}

function splitFragment(raw: string): { target: string; fragment: string | undefined } {
  const hash = raw.indexOf('#')
  if (hash === -1) return { target: raw, fragment: undefined }
  const fragment = raw.slice(hash + 1)
  return { target: raw.slice(0, hash), fragment: fragment.length > 0 ? fragment : undefined }
}

/**
 * Given the index of the `]` or `|` that ends a reference's target, where the
 * reference closes and its alias — or, when this `[[` never closes, where the
 * scan resumes. Resuming past everything inspected is what keeps the scan
 * linear (see `findNextReference`).
 */
function closeReference(
  value: string,
  targetEnd: number,
): { end: number; alias: string | undefined } | { resumeAt: number } {
  if (value[targetEnd] === ']') {
    return value[targetEnd + 1] === ']'
      ? { end: targetEnd + 2, alias: undefined }
      : { resumeAt: targetEnd + 1 }
  }
  let j = targetEnd + 1
  while (j < value.length && value[j] !== ']') j++
  if (j < value.length && value[j + 1] === ']') {
    return { end: j + 2, alias: value.slice(targetEnd + 1, j) }
  }
  return { resumeAt: j + 1 }
}

/**
 * Finds the next `[[...]]`/`![[...]]` occurrence at or after `cursor`, scanning
 * with `indexOf` instead of a regex. A quantified-class regex equivalent to
 * this grammar (`[^\]|]+` for the target, `[^\]]*` for the alias) is
 * super-linear on adversarial input: every `[[` that never finds a closing
 * `]]` forces a fresh forward scan to the end of the string, so a string of
 * N repeated `[[` costs O(N^2). This scan instead advances `cursor`
 * monotonically past everything it has already inspected, so each character
 * is visited a bounded number of times and the whole pass is O(n).
 */
export function findNextReference(value: string, cursor: number): ReferenceMatch | undefined {
  let pos = cursor
  while (pos < value.length) {
    const openIndex = value.indexOf('[[', pos)
    if (openIndex === -1) return undefined

    const hasBang = openIndex > 0 && value[openIndex - 1] === '!'
    const matchStart = hasBang ? openIndex - 1 : openIndex
    const contentStart = openIndex + 2

    let i = contentStart
    while (i < value.length && value[i] !== ']' && value[i] !== '|') i++
    if (i >= value.length) return undefined // no `]`/`|` left anywhere -> no possible match remains

    const { target, fragment } = splitFragment(value.slice(contentStart, i))
    if (target.length === 0) {
      pos = contentStart
      continue
    }

    const close = closeReference(value, i)
    if ('resumeAt' in close) {
      pos = close.resumeAt
      continue
    }
    return {
      index: matchStart,
      full: value.slice(matchStart, close.end),
      isEmbed: hasBang,
      target,
      alias: close.alias,
      fragment,
    }
  }
  return undefined
}

/** Every `[[...]]` / `![[...]]` occurrence in a text value, in order. */
export function scanReferences(value: string): readonly ReferenceMatch[] {
  const matches: ReferenceMatch[] = []
  let cursor = 0
  for (;;) {
    const match = findNextReference(value, cursor)
    if (match === undefined) return matches
    matches.push(match)
    cursor = match.index + match.full.length
  }
}
