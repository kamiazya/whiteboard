import { EditorSelection, EditorState } from '@codemirror/state'
import { describe, expect, it } from 'vitest'
import { exitEmptyListItem } from './exit-empty-list-item.js'

function apply(doc: string, caret: number): string | null {
  const state = EditorState.create({ doc, selection: EditorSelection.single(caret) })
  let next: string | null = null
  const handled = exitEmptyListItem({
    state,
    dispatch: (tr) => {
      next = tr.state.doc.toString()
    },
  })
  return handled ? next : null
}

describe('exitEmptyListItem', () => {
  it('deletes a bare unordered marker at the caret line end', () => {
    expect(apply('- one\n- ', 8)).toBe('- one\n')
  })

  it('deletes ordered and task markers too, keeping indentation lines intact', () => {
    expect(apply('1. one\n2. ', 10)).toBe('1. one\n')
    expect(apply('- [ ] ', 6)).toBe('')
  })

  it('reports unhandled on an item WITH content, so continuation still runs', () => {
    expect(apply('- one', 5)).toBeNull()
  })

  it('reports unhandled mid-line and on non-list lines', () => {
    expect(apply('- ', 1)).toBeNull()
    expect(apply('prose', 5)).toBeNull()
  })
})
