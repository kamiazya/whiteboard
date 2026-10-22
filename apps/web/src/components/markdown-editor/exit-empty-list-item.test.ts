// @vitest-environment node
import { insertNewlineAndIndent } from '@codemirror/commands'
import {
  deleteMarkupBackward,
  insertNewlineContinueMarkup,
  markdown,
} from '@codemirror/lang-markdown'
import { EditorSelection, EditorState } from '@codemirror/state'
import { GFM } from '@lezer/markdown'
import { describe, expect, it } from 'vitest'
import { backspaceEmptyMarkup, exitEmptyListItem } from './exit-empty-list-item.js'

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

  it('leaves a quote on an empty quote line, removing only the marker', () => {
    expect(apply('> one\n> ', 8)).toBe('> one\n')
    expect(apply('> one\n>', 7)).toBe('> one\n')
    expect(apply('> ', 2)).toBe('')
  })

  it('leaves one quote level at a time, and a list item inside a quote keeps the quote', () => {
    expect(apply('> > ', 4)).toBe('> ')
    expect(apply('> - ', 4)).toBe('> ')
  })

  it('reports unhandled on a quote line WITH content', () => {
    expect(apply('> one', 5)).toBeNull()
  })
})

describe('Enter on a quote through the editor chain', () => {
  function enter(doc: string): string {
    let state = EditorState.create({
      doc,
      selection: EditorSelection.single(doc.length),
      extensions: [markdown({ extensions: [GFM] })],
    })
    const target = {
      state,
      dispatch: (tr: { state: EditorState }) => {
        state = tr.state
      },
    }
    // The order SourcePane installs: the exit verb, the language's Enter, then the default one.
    exitEmptyListItem(target) ||
      insertNewlineContinueMarkup(target) ||
      insertNewlineAndIndent(target)
    return state.doc.toString()
  }

  it('continues a non-empty quote line with its marker', () => {
    expect(enter('> one')).toBe('> one\n> ')
  })

  it('exits on the first Enter of an empty quote line, so the next line is plain', () => {
    const afterFirst = enter('> one\n> ')
    expect(afterFirst).toBe('> one\n')
    expect(enter(afterFirst)).toBe('> one\n\n')
  })
})

describe('Backspace on an empty marker', () => {
  function backspace(doc: string): string {
    let state = EditorState.create({
      doc,
      selection: EditorSelection.single(doc.length),
      extensions: [markdown({ extensions: [GFM] })],
    })
    const target = {
      state,
      dispatch: (tr: { state: EditorState }) => {
        state = tr.state
      },
    }
    // The language's Backspace is what runs when this verb stands aside.
    backspaceEmptyMarkup(target) || deleteMarkupBackward(target)
    return state.doc.toString()
  }

  it('removes a bullet, a number and a quote marker, leaving no spaces behind', () => {
    expect(backspace('- one\n- ')).toBe('- one\n')
    expect(backspace('1. one\n2. ')).toBe('1. one\n')
    expect(backspace('> one\n> ')).toBe('> one\n')
  })

  it('stands aside on a line with content', () => {
    expect(
      backspaceEmptyMarkup({
        state: EditorState.create({ doc: '- one', selection: EditorSelection.single(5) }),
        dispatch: () => {},
      }),
    ).toBe(false)
  })
})
