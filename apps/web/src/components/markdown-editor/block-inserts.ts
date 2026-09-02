import { EditorSelection, type StateCommand } from '@codemirror/state'

const FENCE = '```'

type State = Parameters<StateCommand>[0]['state']

/**
 * Where a block goes when the caret asks for one: after the caret's LINE,
 * never inside it. A block is what sits between paragraphs, so a divider
 * tapped mid-word — or with the word still wrapped in `**` after a bold —
 * lands below the line rather than splitting it.
 *
 * `before` guarantees a blank line between the block and any text above:
 * CommonMark reads `milk` + `---` as a setext heading, and inside a list
 * item a table row is lazy continuation of the item's paragraph, so a
 * divider or table tapped right after typing would silently rewrite the
 * line it followed. `after` keeps a following line of text from being read
 * as the block's own tail (a table swallows the next line as a row).
 */
function blockSlot(state: State): {
  readonly at: number
  readonly before: string
  readonly after: string
} {
  const line = state.doc.lineAt(state.selection.main.head)
  const preceding = state.doc.sliceString(0, line.to)
  const before =
    preceding === '' || preceding.endsWith('\n\n') ? '' : preceding.endsWith('\n') ? '\n' : '\n\n'
  const next = line.number < state.doc.lines ? state.doc.line(line.number + 1) : null
  const after = next !== null && next.text.trim() !== '' ? '\n' : ''
  return { at: line.to, before, after }
}

/**
 * Fences the selected lines when there is a selection — the fences take
 * whole lines, so a selection inside a line still fences the line — and
 * otherwise inserts an empty fence below the caret's line with the caret
 * parked on the middle one, ready for the code. The language tag is typed after
 * the opening fence; a picker for it would be a surface, not a transform.
 */
export const insertCodeBlock: StateCommand = ({ state, dispatch }) => {
  const main = state.selection.main
  if (main.empty) {
    const { at, before, after } = blockSlot(state)
    dispatch(
      state.update({
        changes: { from: at, insert: `${before}${FENCE}\n\n${FENCE}${after}` },
        selection: { anchor: at + before.length + FENCE.length + 1 },
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

/**
 * A two-column GFM table skeleton with the first header cell selected, so
 * typing replaces the placeholder rather than appending to it.
 */
export const insertTable: StateCommand = ({ state, dispatch }) => {
  const { at, before, after } = blockSlot(state)
  const header = 'Column'
  const skeleton = `| ${header} | ${header} |\n| --- | --- |\n|  |  |`
  const start = at + before.length + 2
  dispatch(
    state.update({
      changes: { from: at, insert: before + skeleton + after },
      selection: EditorSelection.range(start, start + header.length),
      scrollIntoView: true,
      userEvent: 'input',
    }),
  )
  return true
}

/** A thematic break below the caret's line, with the caret on the line after it. */
export const insertRule: StateCommand = ({ state, dispatch }) => {
  const { at, before, after } = blockSlot(state)
  const rule = `${before}---\n`
  dispatch(
    state.update({
      changes: { from: at, insert: rule + after },
      selection: { anchor: at + rule.length },
      scrollIntoView: true,
      userEvent: 'input',
    }),
  )
  return true
}
