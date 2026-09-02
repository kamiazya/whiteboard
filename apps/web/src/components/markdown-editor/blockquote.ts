import type { StateCommand } from '@codemirror/state'
import { listTargetLines } from './list-line.js'

const QUOTE_RE = /^(\s*)>\s?/

/**
 * Toggles `> ` over the target lines (the list band's rule for which lines
 * those are, so an empty line gets a quote marker to type into). When every
 * target line is already quoted the markers come off, indentation kept;
 * otherwise the unquoted lines gain one. Applying it twice to unquoted lines
 * is therefore the identity.
 */
export const toggleBlockquote: StateCommand = ({ state, dispatch }) => {
  const lines = listTargetLines(state)
  const matches = lines.map((line) => QUOTE_RE.exec(line.text))
  const everyLineHasIt = matches.every((match) => match !== null)
  const changes: { from: number; to: number; insert: string }[] = []
  lines.forEach((line, i) => {
    const match = matches[i]
    if (everyLineHasIt) {
      if (match === null) return
      const indent = match[1].length
      changes.push({ from: line.from + indent, to: line.from + match[0].length, insert: '' })
    } else if (match === null) {
      const indent = /^\s*/.exec(line.text)?.[0].length ?? 0
      changes.push({ from: line.from + indent, to: line.from + indent, insert: '> ' })
    }
  })
  if (changes.length === 0) return false
  const changeSet = state.changes(changes)
  dispatch(
    state.update({
      changes: changeSet,
      selection: state.selection.map(changeSet, 1),
      scrollIntoView: true,
      userEvent: 'input',
    }),
  )
  return true
}
