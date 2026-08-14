import { EditorSelection, EditorState } from '@codemirror/state'
import { describe, expect, it } from 'vitest'
import { toggleTaskCheckbox } from './toggle-task-checkbox.js'

function apply(doc: string, anchor: number, head = anchor): string | null {
  const state = EditorState.create({
    doc,
    selection: EditorSelection.single(anchor, head),
  })
  let next: string | null = null
  const handled = toggleTaskCheckbox({
    state,
    dispatch: (tr) => {
      next = tr.state.doc.toString()
    },
  })
  return handled ? next : null
}

describe('toggleTaskCheckbox', () => {
  it('checks an unchecked task item under the caret', () => {
    expect(apply('- [ ] write tests', 5)).toBe('- [x] write tests')
  })

  it('unchecks a checked task item, whichever case the x has', () => {
    expect(apply('- [x] done', 3)).toBe('- [ ] done')
    expect(apply('- [X] done', 3)).toBe('- [ ] done')
  })

  it('toggles every task line covered by the selection, skipping non-task lines', () => {
    const doc = '- [ ] one\nplain prose\n- [x] two'
    expect(apply(doc, 0, doc.length)).toBe('- [x] one\nplain prose\n- [ ] two')
  })

  it('supports ordered-list and indented task items', () => {
    expect(apply('1. [ ] ordered', 4)).toBe('1. [x] ordered')
    expect(apply('  - [ ] nested', 6)).toBe('  - [x] nested')
  })

  it('returns false and dispatches nothing when no selected line is a task item', () => {
    expect(apply('plain prose', 2)).toBeNull()
    expect(apply('- list without checkbox', 2)).toBeNull()
  })
})
