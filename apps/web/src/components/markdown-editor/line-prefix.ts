import type { EditorState, StateCommand } from '@codemirror/state'

/**
 * One line's block prefix, as the block and list bands see it: indentation,
 * an optional quote marker, a list marker (none, bullet, or a numbered
 * `1.`) with an optional task checkbox — which GFM only recognises after a
 * marker — a heading marker, and then the text. The bands' buttons are
 * moves in this space, spelled out in `editor-verbs.model.property.test.ts`;
 * this module is the real side of that table.
 *
 * The order is the one nesting GFM reads back the way it was written: a
 * quote holds a list, a list item holds a heading. `- > x` is a quote inside
 * an item and `# - x` is a heading whose text starts with a dash, so the
 * commands never write either.
 */
type ListMarker = 'none' | 'bullet' | 'ordered'
type TaskCheckbox = 'none' | 'open' | 'done'

interface LinePrefix {
  /** Whitespace before a quote marker; empty on an unquoted line. */
  readonly quoteIndent: string
  readonly quote: boolean
  /** Whitespace right before the marker (or text) — the nesting indent. */
  readonly indent: string
  readonly marker: ListMarker
  /** What an ordered marker shows; kept on conversion, 1 when freshly made. */
  readonly number: number
  readonly checkbox: TaskCheckbox
  /** 0 for body text. */
  readonly heading: number
  readonly text: string
}

const MAX_HEADING_LEVEL = 6

/**
 * Indentation, a quote marker, then a list marker with the whitespace that
 * makes it one (`-` alone is a dash) and an optional checkbox, then a
 * heading marker with the space that makes IT one (`#tag` is a tag). Text
 * matching rather than a lexer: the shape is shallow, and the same regex
 * gives every band the same reading of the line.
 */
const PREFIX_RE =
  /^(\s*)(?:>\s?(\s*))?(?:(?:([-*+])|(\d+)[.)])\s+(?:\[([ xX])\]\s?)?)?(?:(#{1,6})\s+)?/

function parseLinePrefix(text: string): LinePrefix {
  const match = PREFIX_RE.exec(text)
  if (match === null) throw new Error('PREFIX_RE matches every string')
  const [whole, leading, afterQuote, bullet, number, box, hashes] = match
  const quote = afterQuote !== undefined
  return {
    quoteIndent: quote ? leading : '',
    quote,
    indent: quote ? afterQuote : leading,
    marker: bullet !== undefined ? 'bullet' : number !== undefined ? 'ordered' : 'none',
    number: number !== undefined ? Number.parseInt(number, 10) : 1,
    checkbox: box === undefined ? 'none' : box === ' ' ? 'open' : 'done',
    heading: hashes?.length ?? 0,
    text: text.slice(whole.length),
  }
}

function renderLinePrefix(line: LinePrefix): string {
  const marker = line.marker === 'none' ? '' : line.marker === 'bullet' ? '- ' : `${line.number}. `
  const checkbox = line.checkbox === 'none' ? '' : line.checkbox === 'open' ? '[ ] ' : '[x] '
  const heading = line.heading === 0 ? '' : `${'#'.repeat(line.heading)} `
  return `${line.quoteIndent}${line.quote ? '> ' : ''}${line.indent}${marker}${checkbox}${heading}${line.text}`
}

/**
 * The lines a band button acts on: every non-blank line the selection
 * covers — blank lines inside a selection are separators, not items — or,
 * when the selection covers only blank lines (a caret on an empty line, the
 * commonest press on a phone), the caret's own line, so the button writes
 * the marker to type into instead of doing nothing.
 */
function targetLines(state: EditorState) {
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

function targetPrefixes(state: EditorState): LinePrefix[] {
  return targetLines(state).map((line) => parseLinePrefix(line.text))
}

/**
 * Rewrites each target line's PREFIX through `next`, leaving the text span
 * untouched so a caret in the text keeps its character when the selection
 * is mapped; replacing the whole line would throw every caret to the line's
 * end. Reports unhandled when no line would change, so a keybinding can
 * fall through and a menu item cannot put a junk entry in the undo history.
 */
function rewritePrefixes(next: (line: LinePrefix, index: number) => LinePrefix): StateCommand {
  return ({ state, dispatch }) => {
    const changes: { from: number; to: number; insert: string }[] = []
    targetLines(state).forEach((line, index) => {
      const parsed = parseLinePrefix(line.text)
      const rendered = renderLinePrefix(next(parsed, index))
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
    const everyLineHasIt = targetPrefixes(target.state).every((line) => line.marker === kind)
    return rewritePrefixes((line, index) =>
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
 * A heading gives way to the checkbox: GFM reads `[ ] # x` as text, so a
 * task item cannot be a heading, and the button the user pressed wins.
 */
export const cycleTaskCheckbox: StateCommand = rewritePrefixes((line) => {
  switch (line.checkbox) {
    case 'none':
      return {
        ...line,
        marker: line.marker === 'none' ? 'bullet' : line.marker,
        heading: 0,
        checkbox: 'open',
      }
    case 'open':
      return { ...line, checkbox: 'done' }
    case 'done':
      return { ...line, checkbox: 'none' }
  }
})

/**
 * Toggles the quote marker over the target lines. When every target line is
 * already quoted the markers come off; otherwise the unquoted lines gain
 * one. Applying it twice to unquoted lines is therefore the identity.
 */
export const toggleBlockquote: StateCommand = (target) => {
  const everyLineHasIt = targetPrefixes(target.state).every((line) => line.quote)
  return rewritePrefixes((line) => ({ ...line, quote: !everyLineHasIt }))(target)
}

/** The heading level of the line holding the selection's start; 0 for body text. */
export function headingLevelAt(state: EditorState): number {
  return parseLinePrefix(state.doc.lineAt(state.selection.main.from).text).heading
}

/**
 * Sets every target line to `level` (0 = body text). A heading displaces a
 * checkbox for the reason `cycleTaskCheckbox` displaces a heading: the two
 * cannot both be read, and the pressed button wins. Rejects a level markdown
 * has no marker for rather than writing seven hashes.
 */
export function setHeadingLevel(level: number): StateCommand {
  return (target) => {
    if (!Number.isInteger(level) || level < 0 || level > MAX_HEADING_LEVEL) return false
    return rewritePrefixes((line) => ({
      ...line,
      heading: level,
      checkbox: level > 0 ? 'none' : line.checkbox,
    }))(target)
  }
}

const INDENT_UNIT = 2

/** Where this list line's content starts, relative to its indent: the column a child must begin at. */
function markerWidth(line: LinePrefix): number {
  return line.marker === 'bullet' ? 2 : `${line.number}. `.length
}

/**
 * The indent a list line moves to, or null when the tree has no such move.
 * Nesting is the one verb whose meaning comes from the lines ABOVE: a
 * child must start at its parent's content column, so indenting means
 * "become a child of the sibling above" and the width is that sibling's,
 * not a fixed unit (`1. ` is three wide, `- ` two). With no sibling above
 * — the line is its parent's first child, or the first item of all — there
 * is nothing to nest under, and a unit of indent would be whitespace the
 * parser ignores. Outdenting moves to the nearest shallower list line's
 * indent; at the top there is nowhere shallower to go.
 */
function nestingIndent(
  state: EditorState,
  lineNumber: number,
  current: LinePrefix,
  direction: 1 | -1,
): number | null {
  const depth = current.indent.length
  if (direction < 0 && depth === 0) return null
  for (let n = lineNumber - 1; n >= 1; n--) {
    const text = state.doc.line(n).text
    if (text.trim() === '') continue
    const above = parseLinePrefix(text)
    if (above.marker === 'none' || above.quote !== current.quote) break
    const aboveDepth = above.indent.length
    if (direction > 0) {
      if (aboveDepth > depth) continue
      return aboveDepth === depth ? aboveDepth + markerWidth(above) : null
    }
    if (aboveDepth < depth) return aboveDepth
  }
  // Outdenting a nested line with nothing shallower above it lands at the margin.
  return direction < 0 ? 0 : null
}

/**
 * The indent / outdent button (Tab / Shift-Tab). A list line moves in the
 * tree (see `nestingIndent`); any other line moves by the indent unit, as
 * Tab does in every editor — CommonMark reads four of those as a code
 * block, and that is the author's to spend. A selection moves every
 * covered line by the FIRST line's delta, so nested structure under it
 * keeps its shape.
 */
export function changeIndent(direction: 1 | -1): StateCommand {
  return (target) => {
    const { state } = target
    const first = targetLines(state)[0]
    const parsed = parseLinePrefix(first.text)
    const to =
      parsed.marker === 'none'
        ? Math.max(0, parsed.indent.length + direction * INDENT_UNIT)
        : nestingIndent(state, first.number, parsed, direction)
    if (to === null) return false
    const delta = to - parsed.indent.length
    if (delta === 0) return false
    return rewritePrefixes((line) => ({
      ...line,
      indent: ' '.repeat(Math.max(0, line.indent.length + delta)),
    }))(target)
  }
}
