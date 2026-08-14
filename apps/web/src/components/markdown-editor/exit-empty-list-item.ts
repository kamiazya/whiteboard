import type { StateCommand } from '@codemirror/state'

/**
 * A list line that carries only its marker (optionally a task checkbox)
 * and no content — the state one Enter of auto-continuation leaves behind.
 */
const EMPTY_ITEM_RE = /^\s*(?:[-*+]|\d+[.)])\s*(?:\[[ xX]\]\s*)?$/

/**
 * Enter on an empty list item DELETES the marker instead of continuing
 * the list — the standard escape hatch (Typora, Obsidian, every rich list
 * editor) from lang-markdown's auto-continuation, which would otherwise
 * march the marker down line after line. Bound ABOVE the language keymap;
 * reports unhandled everywhere else so continuation keeps working.
 */
export const exitEmptyListItem: StateCommand = ({ state, dispatch }) => {
  const range = state.selection.main
  if (!range.empty) return false
  const line = state.doc.lineAt(range.head)
  if (range.head !== line.to) return false
  if (!EMPTY_ITEM_RE.test(line.text)) return false
  dispatch(
    state.update({
      changes: { from: line.from, to: line.to, insert: '' },
      selection: { anchor: line.from },
      userEvent: 'delete',
    }),
  )
  return true
}
