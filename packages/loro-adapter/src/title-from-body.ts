/**
 * The title a markdown body announces about itself, if it announces one.
 *
 * Used to NAME a document that nobody named — see `name-from-title`.
 * Deliberately line-anchored text matching rather than a markdown parse: a
 * level-1 ATX heading is only ever `#` + whitespace + text at the start of a
 * line, and a full parse buys nothing at that depth.
 *
 * The rule is narrow on purpose. Only the FIRST non-blank line counts: a
 * heading further down is a section, not the document's title, and naming a
 * document after its third section would be worse than leaving it unnamed.
 */

/**
 * `# ` + text, with the space required — `#tag` is body text. The text must
 * start on a non-blank, so the blank run and the text cannot trade characters:
 * the match is one pass however long the line is.
 */
const ATX_H1 = /^#[ \t]+([^ \t\r\n\u2028\u2029].*)$/

/**
 * Long enough for any title someone means as one, short enough that a name
 * cannot become a paragraph. A heading past this is almost certainly prose
 * that happens to start with `#`, and truncating it would invent a name
 * nobody wrote — so it is refused outright rather than cut.
 */
const MAX_TITLE_LENGTH = 120

/**
 * A first line longer than this is refused before anything reads it. The body
 * is text any writer controls and this runs on every write to an unnamed
 * document, so the work must not grow with the line; whitespace collapsing and
 * marker stripping cannot shrink a line this long into a title anyone wrote.
 */
const MAX_HEADING_LINE_LENGTH = 4 * MAX_TITLE_LENGTH

const isBlank = (char: string | undefined): boolean => char === ' ' || char === '\t'

/**
 * A closed ATX heading (`# Title #`) drops its trailing marker run so the
 * name does not keep a stray marker. EVERY trailing run goes, not just the
 * last one as CommonMark reads it: `# ! # # ` would otherwise answer `! #`,
 * a name that re-reads as `!` — deriving a title must be idempotent, and a
 * marker-only tail is never a name someone meant. `C#` keeps its `#` (no
 * whitespace before it, so it is part of the word, not a marker).
 *
 * Peeled right to left in one pass: a regex for "one or more trailing runs"
 * is unanchored at its start and backtracks quadratically on a blank run.
 */
function stripTrailingMarkerRuns(text: string): string {
  let end = text.length
  while (isBlank(text[end - 1])) end -= 1
  let kept = text.length
  for (;;) {
    let markerStart = end
    while (text[markerStart - 1] === '#') markerStart -= 1
    if (markerStart === end || !isBlank(text[markerStart - 1])) return text.slice(0, kept)
    end = markerStart
    while (isBlank(text[end - 1])) end -= 1
    kept = end
  }
}

export function titleFromMarkdownBody(body: string): string | undefined {
  for (const rawLine of body.split('\n')) {
    if (rawLine.trim() === '') continue
    // The first thing actually written decides. If it is not a heading, the
    // document has not told us what it is called.
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
    if (line.length > MAX_HEADING_LINE_LENGTH) return undefined
    const matched = ATX_H1.exec(line)
    if (matched === null) return undefined
    const title = stripTrailingMarkerRuns(matched[1] ?? '')
      .replace(/\s+/g, ' ')
      .trim()
    if (title === '' || title.length > MAX_TITLE_LENGTH) return undefined
    return title
  }
  return undefined
}
