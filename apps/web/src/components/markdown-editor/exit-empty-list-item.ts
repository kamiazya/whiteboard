import type { StateCommand } from '@codemirror/state'

/**
 * A line that carries only block markup and no content — the state one Enter
 * of auto-continuation leaves behind: any run of quote markers, then
 * optionally a list marker (and a task checkbox). Group 1 is the quote
 * prefix, group 2 the list marker.
 */
const EMPTY_BLOCK_RE = /^(\s*(?:>[ \t]?)*)((?:[-*+]|\d+[.)])[ \t]*(?:\[[ xX]\][ \t]*)?)?$/

/**
 * What the line becomes when its markup is spent: a list marker goes (the
 * quote around it stays), a bare quote loses its innermost level. `null`
 * when the line is not empty block markup at all.
 */
function spentMarkup(text: string): { remaining: string; endsList: boolean } | null {
  const match = EMPTY_BLOCK_RE.exec(text)
  if (match === null) return null
  const [, quotes = '', listMarker] = match
  if (listMarker !== undefined) {
    return { remaining: quotes.includes('>') ? quotes : '', endsList: true }
  }
  if (!quotes.includes('>')) return null
  return { remaining: quotes.slice(0, quotes.lastIndexOf('>')), endsList: false }
}

/** A line with nothing but quote markers and whitespace on it. */
const BLANK_IN_QUOTE_RE = /^\s*(?:>[ \t]?)*\s*$/

function clearSpentMarkup(userEvent: string, separateEndedList: boolean): StateCommand {
  return ({ state, dispatch }) => {
    const range = state.selection.main
    if (!range.empty) return false
    const line = state.doc.lineAt(range.head)
    if (range.head !== line.to) return false
    const spent = spentMarkup(line.text)
    if (spent === null) return false
    const { remaining } = spent
    const separate =
      separateEndedList &&
      spent.endsList &&
      line.number > 1 &&
      !BLANK_IN_QUOTE_RE.test(state.doc.line(line.number - 1).text)
    const insert = separate ? `${remaining.trimEnd()}\n${remaining}` : remaining
    dispatch(
      state.update({
        changes: { from: line.from, to: line.to, insert },
        selection: { anchor: line.from + insert.length },
        userEvent,
      }),
    )
    return true
  }
}

/**
 * Enter on an empty list item or empty quote line DELETES the marker
 * instead of continuing it — the standard escape hatch (Typora, Obsidian,
 * every rich editor) from lang-markdown's auto-continuation, which would
 * otherwise march the marker down line after line, or for a quote leave a
 * bare `>` line behind and pull the following text into the quote. Bound
 * ABOVE the language keymap; reports unhandled everywhere else so
 * continuation keeps working.
 */
export const exitEmptyListItem: StateCommand = clearSpentMarkup('delete', false)

/**
 * {@link exitEmptyListItem}, plus the blank line that actually ENDS the list.
 * Without it the next line typed is a lazy continuation (CommonMark 5.2) and
 * renders inside the last item; only a heading or fence interrupts a list on
 * its own. The note editor's Enter: a line typed after leaving a list is a
 * paragraph of its own.
 */
export const endListOnEmptyItem: StateCommand = clearSpentMarkup('delete', true)

/**
 * Backspace on the same spent marker removes it outright. The language's own
 * Backspace turns a marker into the spaces it occupied, so the line is left
 * holding invisible indentation that the next keystroke inherits.
 */
export const backspaceEmptyMarkup: StateCommand = clearSpentMarkup('delete.backward', false)
