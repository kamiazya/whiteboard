import { EditorSelection, type StateCommand } from '@codemirror/state'

const FENCE = '```'

/**
 * Fences the selected lines when there is a selection — the fences take
 * whole lines, so a selection inside a line still fences the line — and
 * otherwise inserts an empty fence at the caret with the caret parked on
 * its middle line, ready for the code. The language tag is typed after the
 * opening fence; a picker for it would be a surface, not a transform.
 */
export const insertCodeBlock: StateCommand = ({ state, dispatch }) => {
  const main = state.selection.main
  if (main.empty) {
    dispatch(
      state.update({
        changes: { from: main.head, insert: `${FENCE}\n\n${FENCE}` },
        selection: { anchor: main.head + FENCE.length + 1 },
        scrollIntoView: true,
        userEvent: 'input',
      }),
    )
    return true
  }
  const first = state.doc.lineAt(main.from)
  const last = state.doc.lineAt(main.to)
  const opening = `${FENCE}\n`
  dispatch(
    state.update({
      changes: [
        { from: first.from, insert: opening },
        { from: last.to, insert: `\n${FENCE}` },
      ],
      selection: EditorSelection.range(main.from + opening.length, main.to + opening.length),
      scrollIntoView: true,
      userEvent: 'input',
    }),
  )
  return true
}

/** Breaks onto a fresh line unless the caret already sits at the start of an empty one. */
function ownLinePrefix(state: Parameters<StateCommand>[0]['state']): string {
  const line = state.doc.lineAt(state.selection.main.head)
  return line.text === '' ? '' : '\n'
}

/**
 * A two-column GFM table skeleton with the first header cell selected, so
 * typing replaces the placeholder rather than appending to it.
 */
export const insertTable: StateCommand = ({ state, dispatch }) => {
  const head = state.selection.main.head
  const prefix = ownLinePrefix(state)
  const header = 'Column'
  const skeleton = `| ${header} | ${header} |\n| --- | --- |\n|  |  |`
  const start = head + prefix.length + 2
  dispatch(
    state.update({
      changes: { from: head, insert: prefix + skeleton },
      selection: EditorSelection.range(start, start + header.length),
      scrollIntoView: true,
      userEvent: 'input',
    }),
  )
  return true
}

/** A thematic break on its own line, with the caret on the line after it. */
export const insertRule: StateCommand = ({ state, dispatch }) => {
  const head = state.selection.main.head
  const insert = `${ownLinePrefix(state)}---\n`
  dispatch(
    state.update({
      changes: { from: head, insert },
      selection: { anchor: head + insert.length },
      scrollIntoView: true,
      userEvent: 'input',
    }),
  )
  return true
}
