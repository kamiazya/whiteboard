// The block and list bands' commands on the cases the model test cannot
// spell out: caret placement, multi-line selections, indentation, and the
// empty line the bar is most often pressed on.
import { EditorSelection, EditorState, type StateCommand } from '@codemirror/state'
import { describe, expect, it } from 'vitest'
import {
  changeIndent,
  cycleTaskCheckbox,
  headingLevelAt,
  setHeadingLevel,
  setListMarker,
  toggleBlockquote,
} from './line-prefix.js'

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

function docAfter(command: StateCommand, doc: string, anchor: number, head = anchor) {
  return apply(command, doc, anchor, head)?.doc ?? null
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
    expect(docAfter(setListMarker('ordered'), doc, 0, doc.length)).toBe('1. one\n\n2. two')
  })

  it('removes the marker only when every covered line already has it', () => {
    expect(docAfter(setListMarker('bullet'), '- one\ntwo', 0, 9)).toBe('- one\n- two')
    expect(docAfter(setListMarker('bullet'), '- one\n- two', 0, 11)).toBe('one\ntwo')
  })

  it('converts between marker kinds, keeping a checkbox and the indentation', () => {
    expect(docAfter(setListMarker('ordered'), '  - [ ] nested', 8)).toBe('  1. [ ] nested')
    expect(docAfter(setListMarker('bullet'), '3. [x] done', 5)).toBe('- [x] done')
  })

  it('puts the marker inside a quote, where GFM reads it as a quoted list', () => {
    expect(docAfter(setListMarker('bullet'), '> quoted', 3)).toBe('> - quoted')
    expect(docAfter(setListMarker('bullet'), '> - quoted', 5)).toBe('> quoted')
  })
})

describe('cycleTaskCheckbox', () => {
  it('makes an empty line an open task, caret ready for the text', () => {
    expect(apply(cycleTaskCheckbox, '', 0)).toEqual({ doc: '- [ ] ', head: 6 })
  })

  it('cycles none -> open -> done -> none, keeping the marker', () => {
    expect(docAfter(cycleTaskCheckbox, '- item', 3)).toBe('- [ ] item')
    expect(docAfter(cycleTaskCheckbox, '- [ ] item', 7)).toBe('- [x] item')
    expect(docAfter(cycleTaskCheckbox, '- [X] item', 7)).toBe('- item')
    expect(docAfter(cycleTaskCheckbox, '1. [x] ordered', 4)).toBe('1. ordered')
  })

  it('advances every covered line independently', () => {
    const doc = '- [ ] one\nplain prose\n- [x] two'
    expect(docAfter(cycleTaskCheckbox, doc, 0, doc.length)).toBe(
      '- [x] one\n- [ ] plain prose\n- two',
    )
  })

  it('displaces a heading, which GFM cannot read after a checkbox', () => {
    expect(docAfter(cycleTaskCheckbox, '- # item', 4)).toBe('- [ ] item')
  })
})

describe('toggleBlockquote', () => {
  it('quotes an empty line, and wraps a list item from the outside', () => {
    expect(apply(toggleBlockquote, '', 0)).toEqual({ doc: '> ', head: 2 })
    expect(docAfter(toggleBlockquote, '- item', 3)).toBe('> - item')
    expect(docAfter(toggleBlockquote, '> - item', 5)).toBe('- item')
  })

  it('quotes every covered line and unquotes only when all are quoted', () => {
    expect(docAfter(toggleBlockquote, '> one\ntwo', 0, 9)).toBe('> one\n> two')
    expect(docAfter(toggleBlockquote, '> one\n> two', 0, 11)).toBe('one\ntwo')
  })
})

describe('setHeadingLevel', () => {
  const heading = (doc: string, level: number, anchor: number, head = anchor) =>
    docAfter(setHeadingLevel(level), doc, anchor, head)

  it('promotes body text to a heading', () => {
    expect(heading('weekly review', 3, 4)).toBe('### weekly review')
  })

  it('changes an existing heading to another level', () => {
    expect(heading('# weekly review', 2, 4)).toBe('## weekly review')
  })

  it('demotes a heading back to body text', () => {
    expect(heading('### weekly review', 0, 6)).toBe('weekly review')
  })

  it('normalizes the space after the marker rather than preserving the old run', () => {
    expect(heading('#     weekly', 1, 8)).toBe('# weekly')
  })

  it('applies to every line the selection covers', () => {
    const doc = 'one\ntwo\nthree'
    expect(heading(doc, 2, 0, doc.length)).toBe('## one\n## two\n## three')
  })

  it('skips the blank lines inside a selection but writes a marker on a lone empty line', () => {
    const doc = 'one\n\ntwo'
    expect(heading(doc, 1, 0, doc.length)).toBe('# one\n\n# two')
    expect(apply(setHeadingLevel(1), '', 0)).toEqual({ doc: '# ', head: 2 })
  })

  it('writes the marker inside a quote or list item, where GFM reads it', () => {
    expect(heading('> - item', 1, 5)).toBe('> - # item')
    expect(heading('> - # item', 0, 7)).toBe('> - item')
  })

  it('displaces a checkbox, which GFM cannot read before a heading', () => {
    expect(heading('- [ ] item', 2, 7)).toBe('- ## item')
  })

  it('reports unhandled when every covered line already sits at that level', () => {
    expect(heading('## already', 2, 4)).toBeNull()
    expect(heading('plain', 0, 2)).toBeNull()
  })

  it('rejects a level outside markdown headings instead of writing seven hashes', () => {
    expect(heading('body', 7, 1)).toBeNull()
    expect(heading('body', -1, 1)).toBeNull()
  })
})

describe('headingLevelAt', () => {
  const levelOf = (doc: string, anchor: number) =>
    headingLevelAt(EditorState.create({ doc, selection: EditorSelection.single(anchor) }))

  it('reads the level of the line holding the caret, past any quote or list prefix', () => {
    expect(levelOf('## weekly', 4)).toBe(2)
    expect(levelOf('weekly', 4)).toBe(0)
    expect(levelOf('> - ### weekly', 8)).toBe(3)
  })

  it('reads the FIRST covered line when a selection spans several', () => {
    expect(levelOf('# one\n## two', 0)).toBe(1)
  })

  it('does not mistake a hash without a space for a heading', () => {
    expect(levelOf('#tag not a heading', 4)).toBe(0)
  })
})

describe('changeIndent', () => {
  const indent = changeIndent(1)
  const outdent = changeIndent(-1)

  it("nests a list line under the sibling above, at that sibling's content column", () => {
    expect(docAfter(indent, '- a\n- b', 7)).toBe('- a\n  - b')
    expect(docAfter(indent, '1. a\n- b', 8)).toBe('1. a\n   - b')
    expect(docAfter(indent, '> - a\n> - b', 11)).toBe('> - a\n>   - b')
  })

  it('reports unhandled when there is no sibling to nest under', () => {
    expect(apply(indent, '- a', 3)).toBeNull()
    expect(apply(indent, '- a\n  - b', 9)).toBeNull()
    expect(apply(indent, 'prose\n- a', 9)).toBeNull()
  })

  it('outdents to the nearest shallower list line, and not past the margin', () => {
    expect(docAfter(outdent, '1. a\n   - b\n     - c', 20)).toBe('1. a\n   - b\n   - c')
    expect(docAfter(outdent, '- a\n  - b', 9)).toBe('- a\n- b')
    expect(apply(outdent, '- a\n- b', 7)).toBeNull()
  })

  it('moves any other line by the indent unit, the way Tab does', () => {
    expect(apply(indent, 'prose', 5)).toEqual({ doc: '  prose', head: 7 })
    expect(docAfter(outdent, '    prose', 9)).toBe('  prose')
    expect(apply(outdent, 'prose', 2)).toBeNull()
  })

  it("moves every covered line by the first line's delta, keeping the shape below it", () => {
    const doc = '- a\n- b\n  - c'
    expect(docAfter(indent, doc, 4, doc.length)).toBe('- a\n  - b\n    - c')
  })
})
