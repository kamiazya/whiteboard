import { EditorState, Transaction } from '@codemirror/state'
import { describe, expect, it } from 'vitest'
import { externalValue } from '../../lib/text-length-limit.js'
import { markdownLengthLimit } from './markdown-length-limit.js'

const LIMIT = 10

function stateWith(doc: string): EditorState {
  return EditorState.create({ doc, extensions: [markdownLengthLimit(LIMIT)] })
}

describe('markdownLengthLimit', () => {
  it('refuses an edit that takes the document past the limit', () => {
    const state = stateWith('12345')
    expect(state.update({ changes: { from: 5, insert: '678901' } }).state.doc.toString()).toBe(
      '12345',
    )
  })

  it('lets an edit land exactly at the limit', () => {
    const state = stateWith('12345')
    expect(state.update({ changes: { from: 5, insert: '67890' } }).state.doc).toHaveLength(LIMIT)
  })

  it('lets a document already past the limit shrink, and refuses its growth', () => {
    const state = stateWith('x'.repeat(LIMIT + 5))
    expect(state.update({ changes: { from: 0, to: 2 } }).state.doc).toHaveLength(LIMIT + 3)
    expect(state.update({ changes: { from: 0, insert: 'y' } }).state.doc).toHaveLength(LIMIT + 5)
  })

  it('does not judge what arrives from the document or the host', () => {
    const state = stateWith('12345')
    const remote = state.update({
      changes: { from: 5, insert: '678901' },
      annotations: Transaction.addToHistory.of(false),
    })
    const reconciled = state.update({
      changes: { from: 5, insert: '678901' },
      annotations: externalValue.of(true),
    })
    expect(remote.state.doc).toHaveLength(11)
    expect(reconciled.state.doc).toHaveLength(11)
  })
})
