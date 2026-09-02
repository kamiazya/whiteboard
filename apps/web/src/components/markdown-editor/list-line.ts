import type { EditorState, StateCommand } from '@codemirror/state'

/**
 * One line of a markdown list, as the list band sees it: a marker (none,
 * bullet, or a numbered `1.`), an optional task checkbox — which GFM only
 * recognises after a marker — and the text. The band's buttons are moves
 * in this space, spelled out in `list-band.model.property.test.ts`; this
 * module is the real side of that table.
 */
type ListMarker = 'none' | 'bullet' | 'ordered'
type TaskCheckbox = 'none' | 'open' | 'done'

interface ListLine {
  readonly indent: string
  readonly marker: ListMarker
  /** What an ordered marker shows; kept on conversion, 1 when freshly made. */
  readonly number: number
  readonly checkbox: TaskCheckbox
  readonly text: string
}

/**
 * Indentation, then a marker with the whitespace that makes it one (`-`
 * alone is a dash), then an optional checkbox. Text matching, like the
 * heading and quote commands: the shape is shallow and a lexer buys nothing.
 */
const LINE_RE = /^(\s*)(?:([-*+])|(\d+)[.)])\s+(?:\[([ xX])\]\s?)?/

function parseListLine(text: string): ListLine {
  const match = LINE_RE.exec(text)
  if (match === null) {
    const indent = /^\s*/.exec(text)?.[0] ?? ''
    return { indent, marker: 'none', number: 1, checkbox: 'none', text: text.slice(indent.length) }
  }
  const [whole, indent, bullet, number, box] = match
  return {
    indent,
    marker: bullet !== undefined ? 'bullet' : 'ordered',
    number: number !== undefined ? Number.parseInt(number, 10) : 1,
    checkbox: box === undefined ? 'none' : box === ' ' ? 'open' : 'done',
    text: text.slice(whole.length),
  }
}

function renderListLine(line: ListLine): string {
  const marker = line.marker === 'none' ? '' : line.marker === 'bullet' ? '- ' : `${line.number}. `
  const checkbox = line.checkbox === 'none' ? '' : line.checkbox === 'open' ? '[ ] ' : '[x] '
  return `${line.indent}${marker}${checkbox}${line.text}`
}

/**
 * The lines a band button acts on: every non-blank line the selection
 * covers — blank lines inside a selection are separators, not items — or,
 * when the selection covers only blank lines (a caret on an empty line, the
 * commonest press on a phone), the caret's own line, so the button makes an
 * item to type into instead of doing nothing.
 */
export function listTargetLines(state: EditorState) {
  const numbers = new Set<number>()
  for (const range of state.selection.ranges) {
    const first = state.doc.lineAt(range.from).number
    const last = state.doc.lineAt(range.to).number
    for (let n = first; n <= last; n++) numbers.add(n)
  }
  const lines = [...numbers].sort((a, b) => a - b).map((n) => state.doc.line(n))
  const nonBlank = lines.filter((line) => line.text.trim() !== '')
  return nonBlank.length > 0 ? nonBlank : [state.doc.lineAt(state.selection.main.head)]
}

/**
 * Rewrites each target line's PREFIX (indent, marker, checkbox) through
 * `next`, leaving the text span untouched so a caret in the text keeps its
 * character when the selection is mapped; replacing the whole line would
 * throw every caret to the line's end.
 */
function rewriteLines(next: (line: ListLine, index: number) => ListLine): StateCommand {
  return ({ state, dispatch }) => {
    const changes: { from: number; to: number; insert: string }[] = []
    listTargetLines(state).forEach((line, index) => {
      const parsed = parseListLine(line.text)
      const rendered = renderListLine(next(parsed, index))
      if (rendered === line.text) return
      const oldPrefix = line.text.length - parsed.text.length
      const newPrefix = rendered.slice(0, rendered.length - parsed.text.length)
      changes.push({ from: line.from, to: line.from + oldPrefix, insert: newPrefix })
    })
    if (changes.length === 0) return false
    const changeSet = state.changes(changes)
    dispatch(
      state.update({
        changes: changeSet,
        // assoc 1: a caret at the marker's insertion point lands after it.
        selection: state.selection.map(changeSet, 1),
        scrollIntoView: true,
        userEvent: 'input',
      }),
    )
    return true
  }
}

/**
 * The bullet / numbered button. Every target line already carries this
 * marker: remove it, and the checkbox with it (a checkbox without a marker
 * is not a task). Otherwise every target line gets this marker — a
 * conversion keeps its checkbox — numbered 1..n in selection order.
 */
export function setListMarker(kind: 'bullet' | 'ordered'): StateCommand {
  return (target) => {
    const parsed = listTargetLines(target.state).map((line) => parseListLine(line.text))
    const everyLineHasIt = parsed.every((line) => line.marker === kind)
    return rewriteLines((line, index) =>
      everyLineHasIt
        ? { ...line, marker: 'none', checkbox: 'none' }
        : { ...line, marker: kind, number: kind === 'ordered' ? index + 1 : line.number },
    )(target)
  }
}

/**
 * The task button: the checkbox cycles none -> open -> done -> none on each
 * target line, the way the heading slot walks its levels and comes back. A
 * line with no marker gets a bullet along with its first checkbox; the
 * marker stays when the checkbox comes off, so the line remains an item.
 */
export const cycleTaskCheckbox: StateCommand = rewriteLines((line) => {
  switch (line.checkbox) {
    case 'none':
      return { ...line, marker: line.marker === 'none' ? 'bullet' : line.marker, checkbox: 'open' }
    case 'open':
      return { ...line, checkbox: 'done' }
    case 'done':
      return { ...line, checkbox: 'none' }
  }
})
