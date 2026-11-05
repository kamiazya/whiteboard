/**
 * The body as Read mode shows it: a leading `# Title` that repeats the
 * document's name is blanked, because the header above the body already prints
 * that name and two identical headings read as a rendering mistake.
 *
 * Blanked rather than cut so every offset stays where the source has it —
 * conversation markers and scroll anchors are positions in this text.
 */
function titleHeading(body: string, title: string | undefined) {
  const name = title?.trim().toLowerCase()
  if (name === undefined || name === '') return undefined
  const heading = /^(?:[ \t]*\r?\n)*([ \t]{0,3}#[ \t]+(.*?)[ \t]*#*[ \t]*)(?:\r?\n|$)/.exec(body)
  if (heading === null) return undefined
  const [whole, line, text] = heading
  if (text === undefined || line === undefined || text.trim().toLowerCase() !== name) {
    return undefined
  }
  return { whole, line }
}

/** Whether `body` opens with a `# Title` heading repeating the document's name. */
export function opensWithTitle(body: string, title: string | undefined): boolean {
  return titleHeading(body, title) !== undefined
}

function withoutTitleHeading(body: string, title: string | undefined): string {
  const heading = titleHeading(body, title)
  if (heading === undefined) return body
  const { whole, line } = heading
  const start =
    whole.length - (whole.endsWith('\n') ? (whole.endsWith('\r\n') ? 2 : 1) : 0) - line.length
  return body.slice(0, start) + ' '.repeat(line.length) + body.slice(start + line.length)
}

/** What the preview column draws for `body`: Read mode with a header drops the repeated title. */
export function shownBody(
  body: string,
  mode: string,
  hasHeader: boolean,
  title: string | undefined,
): string {
  return mode === 'read' && hasHeader ? withoutTitleHeading(body, title) : body
}
