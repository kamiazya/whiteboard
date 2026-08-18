import { EditorSelection, EditorState } from '@codemirror/state'
import { describe, expect, it } from 'vitest'
import { rangeToActOn } from './word-at.js'

function scopeOf(doc: string, anchor: number, head = anchor): string {
  const state = EditorState.create({ doc, selection: EditorSelection.single(anchor, head) })
  const range = rangeToActOn(state)
  return doc.slice(range.from, range.to)
}

describe('rangeToActOn', () => {
  it('returns the selection when there is one', () => {
    expect(scopeOf('weekly review notes', 7, 13)).toBe('review')
  })

  it('falls back to the word under a collapsed caret', () => {
    expect(scopeOf('weekly review notes', 9)).toBe('review')
  })

  it('takes the word the caret sits at the END of', () => {
    expect(scopeOf('weekly review notes', 13)).toBe('review')
  })

  // The whole reason this is not a whitespace split: Japanese writes no
  // spaces, so a whitespace run is a whole clause rather than a word.
  it('splits Japanese at word boundaries, not at spaces', () => {
    const picked = scopeOf('今日は会議の準備をする', 4)
    expect(picked.length).toBeLessThan('今日は会議の準備をする'.length)
    expect('今日は会議の準備をする').toContain(picked)
    expect(picked.trim()).not.toBe('')
  })

  it('gives an empty range on a blank line rather than swallowing the newline', () => {
    expect(scopeOf('one\n\ntwo', 4)).toBe('')
  })

  it('never crosses a line boundary', () => {
    expect(scopeOf('alpha\nbeta', 5)).toBe('alpha')
    expect(scopeOf('alpha\nbeta', 6)).toBe('beta')
  })

  it('does not treat a space as the word to act on', () => {
    expect(scopeOf('weekly review', 6)).toBe('weekly')
  })
})
