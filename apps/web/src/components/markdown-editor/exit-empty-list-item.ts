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
function spentMarkup(text: string): string | null {
  const match = EMPTY_BLOCK_RE.exec(text)
  if (match === null) return null
  const [, quotes = '', listMarker] = match
  if (listMarker !== undefined) return quotes.includes('>') ? quotes : ''
  if (!quotes.includes('>')) return null
  return quotes.slice(0, quotes.lastIndexOf('>'))
}

function clearSpentMarkup(userEvent: string): StateCommand {
  return ({ state, dispatch }) => {
    const range = state.selection.main
    if (!range.empty) return false
    const line = state.doc.lineAt(range.head)
    if (range.head !== line.to) return false
    const remaining = spentMarkup(line.text)
    if (remaining === null) return false
    dispatch(
      state.update({
        changes: { from: line.from, to: line.to, insert: remaining },
        selection: { anchor: line.from + remaining.length },
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
export const exitEmptyListItem: StateCommand = clearSpentMarkup('delete')

/**
 * Backspace on the same spent marker removes it outright. The language's own
 * Backspace turns a marker into the spaces it occupied, so the line is left
 * holding invisible indentation that the next keystroke inherits.
 */
export const backspaceEmptyMarkup: StateCommand = clearSpentMarkup('delete.backward')
