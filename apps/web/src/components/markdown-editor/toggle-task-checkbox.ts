import type { StateCommand } from '@codemirror/state'

/**
 * `- [ ]` / `- [x]` at the start of a list item, with the checkbox-state
 * character captured on its own so the toggle replaces exactly one char.
 * Deliberately line-anchored text matching rather than lexer work: a task
 * marker is only ever list-marker + `[state]` at line start, and the
 * source pane's other insert commands (`wrapSelectionWith`) set the same
 * predictability-over-cleverness precedent.
 */
const TASK_ITEM_RE = /^(\s*(?:[-*+]|\d+[.)])\s+\[)([ xX])\]/

/**
 * Toggles the checkbox of every task item covered by the selection —
 * `[ ]` becomes `[x]` and `[x]`/`[X]` becomes `[ ]`. Lines that are not
 * task items are left untouched; when NO covered line is one, the command
 * reports unhandled so the key can fall through to other bindings.
 */
export const toggleTaskCheckbox: StateCommand = ({ state, dispatch }) => {
  const lineNumbers = new Set<number>()
  for (const range of state.selection.ranges) {
    const first = state.doc.lineAt(range.from).number
    const last = state.doc.lineAt(range.to).number
    for (let n = first; n <= last; n++) lineNumbers.add(n)
  }
  const changes: { from: number; to: number; insert: string }[] = []
  for (const n of lineNumbers) {
    const line = state.doc.line(n)
    const match = TASK_ITEM_RE.exec(line.text)
    if (!match) continue
    const statePos = line.from + match[1].length
    changes.push({ from: statePos, to: statePos + 1, insert: match[2] === ' ' ? 'x' : ' ' })
  }
  if (changes.length === 0) return false
  dispatch(state.update({ changes, userEvent: 'input' }))
  return true
}
