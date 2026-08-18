import { EditorSelection, EditorState } from '@codemirror/state'
import { describe, expect, it } from 'vitest'
import { headingLevelAt, setHeadingLevel } from './set-heading-level.js'

function apply(doc: string, level: number, anchor: number, head = anchor): string | null {
  const state = EditorState.create({ doc, selection: EditorSelection.single(anchor, head) })
  let next: string | null = null
  const handled = setHeadingLevel(level)({
    state,
    dispatch: (tr) => {
      next = tr.state.doc.toString()
    },
  })
  return handled ? next : null
}

function levelOf(doc: string, anchor: number): number {
  return headingLevelAt(EditorState.create({ doc, selection: EditorSelection.single(anchor) }))
}

describe('setHeadingLevel', () => {
  it('promotes body text to a heading', () => {
    expect(apply('weekly review', 3, 4)).toBe('### weekly review')
  })

  it('changes an existing heading to another level', () => {
    expect(apply('# weekly review', 2, 4)).toBe('## weekly review')
  })

  it('demotes a heading back to body text', () => {
    expect(apply('### weekly review', 0, 6)).toBe('weekly review')
  })

  it('normalizes the space after the marker rather than preserving the old run', () => {
    expect(apply('#     weekly', 1, 8)).toBe('# weekly')
  })

  it('applies to every line the selection covers', () => {
    const doc = 'one\ntwo\nthree'
    expect(apply(doc, 2, 0, doc.length)).toBe('## one\n## two\n## three')
  })

  it('leaves a blank line alone — a bare marker is not a heading', () => {
    const doc = 'one\n\ntwo'
    expect(apply(doc, 1, 0, doc.length)).toBe('# one\n\n# two')
  })

  it('reports unhandled when every covered line already sits at that level', () => {
    expect(apply('## already', 2, 4)).toBeNull()
    expect(apply('plain', 0, 2)).toBeNull()
  })

  it('rejects a level outside markdown headings instead of writing seven hashes', () => {
    expect(apply('body', 7, 1)).toBeNull()
    expect(apply('body', -1, 1)).toBeNull()
  })
})

describe('headingLevelAt', () => {
  it('reads the level of the line holding the caret', () => {
    expect(levelOf('## weekly', 4)).toBe(2)
    expect(levelOf('weekly', 4)).toBe(0)
  })

  it('reads the FIRST covered line when a selection spans several', () => {
    const doc = '# one\n## two'
    expect(levelOf(doc, 0)).toBe(1)
  })

  it('does not mistake a hash without a space for a heading', () => {
    expect(levelOf('#tag not a heading', 4)).toBe(0)
  })
})
