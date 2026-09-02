// The list band's commands on the cases the model test cannot spell out:
// caret placement, multi-line selections, indentation, and the empty line
// the bar is most often pressed on.
import { EditorSelection, EditorState, type StateCommand } from '@codemirror/state'
import { describe, expect, it } from 'vitest'
import { cycleTaskCheckbox, setListMarker } from './list-line.js'

function apply(
  command: StateCommand,
  doc: string,
  anchor: number,
  head = anchor,
): { doc: string; head: number } | null {
  const state = EditorState.create({ doc, selection: EditorSelection.single(anchor, head) })
  let next: { doc: string; head: number } | null = null
  const handled = command({
    state,
    dispatch: (tr) => {
      next = { doc: tr.state.doc.toString(), head: tr.state.selection.main.head }
    },
  })
  return handled ? next : null
}

describe('setListMarker', () => {
  it('turns an empty line into a list item with the caret after the marker', () => {
    expect(apply(setListMarker('bullet'), '', 0)).toEqual({ doc: '- ', head: 2 })
    expect(apply(setListMarker('ordered'), '', 0)).toEqual({ doc: '1. ', head: 3 })
  })

  it('keeps the caret on its character when a marker is added or removed', () => {
    expect(apply(setListMarker('bullet'), 'ship it', 4)).toEqual({ doc: '- ship it', head: 6 })
    expect(apply(setListMarker('bullet'), '- ship it', 6)).toEqual({ doc: 'ship it', head: 4 })
  })

  it('numbers a multi-line selection in order and skips blank lines', () => {
    const doc = 'one\n\ntwo'
    expect(apply(setListMarker('ordered'), doc, 0, doc.length)?.doc).toBe('1. one\n\n2. two')
  })

  it('removes the marker only when every covered line already has it', () => {
    expect(apply(setListMarker('bullet'), '- one\ntwo', 0, 9)?.doc).toBe('- one\n- two')
    expect(apply(setListMarker('bullet'), '- one\n- two', 0, 11)?.doc).toBe('one\ntwo')
  })

  it('converts between marker kinds, keeping a checkbox and the indentation', () => {
    expect(apply(setListMarker('ordered'), '  - [ ] nested', 8)?.doc).toBe('  1. [ ] nested')
    expect(apply(setListMarker('bullet'), '3. [x] done', 5)?.doc).toBe('- [x] done')
  })
})

describe('cycleTaskCheckbox', () => {
  it('makes an empty line an open task, caret ready for the text', () => {
    expect(apply(cycleTaskCheckbox, '', 0)).toEqual({ doc: '- [ ] ', head: 6 })
  })

  it('cycles none -> open -> done -> none, keeping the marker', () => {
    expect(apply(cycleTaskCheckbox, '- item', 3)?.doc).toBe('- [ ] item')
    expect(apply(cycleTaskCheckbox, '- [ ] item', 7)?.doc).toBe('- [x] item')
    expect(apply(cycleTaskCheckbox, '- [X] item', 7)?.doc).toBe('- item')
    expect(apply(cycleTaskCheckbox, '1. [x] ordered', 4)?.doc).toBe('1. ordered')
  })

  it('advances every covered line independently', () => {
    const doc = '- [ ] one\nplain prose\n- [x] two'
    expect(apply(cycleTaskCheckbox, doc, 0, doc.length)?.doc).toBe(
      '- [x] one\n- [ ] plain prose\n- two',
    )
  })
})
