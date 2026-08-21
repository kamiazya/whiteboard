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
  target: string
  alias: string | undefined
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

    const target = value.slice(contentStart, i)
    if (target.length === 0) {
      pos = contentStart
      continue
    }

    if (value[i] === ']') {
      if (value[i + 1] === ']') {
        return {
          index: matchStart,
          full: value.slice(matchStart, i + 2),
          isEmbed: hasBang,
          target,
          alias: undefined,
        }
      }
      pos = i + 1
      continue
    }

    let j = i + 1
    while (j < value.length && value[j] !== ']') j++
    if (j < value.length && value[j + 1] === ']') {
      const alias = value.slice(i + 1, j)
      return {
        index: matchStart,
        full: value.slice(matchStart, j + 2),
        isEmbed: hasBang,
        target,
        alias,
      }
    }
    pos = j + 1
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
