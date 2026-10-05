import { EditorSelection, EditorState, type StateCommand } from '@codemirror/state'
import { describe, expect, it } from 'vitest'
import { insertCodeBlock } from './block-inserts.js'

/** Runs `command`, then types `typed` at the selection it left. */
function runThenType(
  command: StateCommand,
  doc: string,
  anchor: number,
  head: number,
  typed: string,
): { readonly handled: boolean; readonly doc: string } {
  let state = EditorState.create({ doc, selection: EditorSelection.single(anchor, head) })
  const handled = command({ state, dispatch: (tr) => (state = tr.state) })
  state = state.update(state.replaceSelection(typed)).state
  return { handled, doc: state.doc.toString() }
}

describe('insertCodeBlock', () => {
  it('parks the caret on the empty line between the fences, so typed code is inside them', () => {
    expect(runThenType(insertCodeBlock, 'milk', 4, 4, 'x')).toEqual({
      handled: true,
      doc: 'milk\n\n```\nx\n```',
    })
  })

  it('reports a fenced selection as handled', () => {
    expect(runThenType(insertCodeBlock, 'alpha', 0, 5, 'beta')).toEqual({
      handled: true,
      doc: '```\nbeta\n```',
    })
  })
})
