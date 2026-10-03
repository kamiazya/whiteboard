/**
 * The toggle reads the nest around the caret from BOTH sides, so `**a** word` is not a bold
 * `word`. The two property files beside this one hold the algebra; these are the examples the
 * nest comment in `editor-verbs.ts` promises.
 */
import { EditorSelection, EditorState } from '@codemirror/state'
import { describe, expect, it } from 'vitest'
import { selfContainedCommand, verb } from './editor-verbs.js'

function run(doc: string, caret: number): string {
  let state = EditorState.create({ doc, selection: EditorSelection.cursor(caret) })
  const command = selfContainedCommand(verb('bold'))
  if (command === null) throw new Error('bold has no self-contained command')
  command({ state, dispatch: (tr) => (state = tr.state) })
  return state.doc.toString()
}

describe('the bold toggle', () => {
  it('wraps a word that merely follows a bold one', () => {
    expect(run('**a** word', 8)).toBe('**a** **word**')
  })

  it('wraps a word that merely precedes a bold one', () => {
    expect(run('word **a**', 2)).toBe('**word** **a**')
  })

  it('strips the bold from a word that is inside one', () => {
    expect(run('**word**', 4)).toBe('word')
  })

  it('does not take an unmatched opener, or an unmatched closer, for a pair', () => {
    expect(run('**word', 4)).toBe('****word**')
    expect(run('word**', 2)).toBe('**word****')
  })
})
