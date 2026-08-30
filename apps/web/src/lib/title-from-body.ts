/**
 * The title a markdown body announces about itself, if it announces one.
 *
 * Used to NAME a document that nobody named — see `use-markdown-document`.
 * Deliberately line-anchored text matching rather than a markdown parse, the
 * same call `set-heading-level.ts` and `toggle-task-checkbox.ts` make and for
 * the same reason: a level-1 ATX heading is only ever `#` + whitespace + text
 * at the start of a line, and a full parse buys nothing at that depth.
 *
 * The rule is narrow on purpose. Only the FIRST non-blank line counts: a
 * heading further down is a section, not the document's title, and naming a
 * document after its third section would be worse than leaving it unnamed.
 */

/**
 * `# ` + text, with the space required — `#tag` is body text, matching
 * `set-heading-level.ts`'s heading rule. A closed ATX heading (`# Title #`)
 * drops its trailing run so the name does not keep a stray marker.
 */
const ATX_H1 = /^#[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/

/**
 * Long enough for any title someone means as one, short enough that a name
 * cannot become a paragraph. A heading past this is almost certainly prose
 * that happens to start with `#`, and truncating it would invent a name
 * nobody wrote — so it is refused outright rather than cut.
 */
const MAX_TITLE_LENGTH = 120

export function titleFromMarkdownBody(body: string): string | undefined {
  for (const line of body.split('\n')) {
    if (line.trim() === '') continue
    // The first thing actually written decides. If it is not a heading, the
    // document has not told us what it is called.
    const matched = ATX_H1.exec(line)
    if (matched === null) return undefined
    const title = (matched[1] ?? '').replace(/\s+/g, ' ').trim()
    if (title === '' || title.length > MAX_TITLE_LENGTH) return undefined
    return title
  }
  return undefined
}
