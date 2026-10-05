import { EditorState } from '@codemirror/state'
import { COMMENT_MESSAGE_MAX_CHARS } from '@kamiazya/whiteboard-model'
import { describe, expect, it } from 'vitest'
import { commentMessageLengthLimit } from './comment-message-limit.js'

function stateWith(doc: string): EditorState {
  return EditorState.create({ doc, extensions: [commentMessageLengthLimit] })
}

describe('commentMessageLengthLimit', () => {
  it('refuses an edit that takes the message past the message limit', () => {
    const state = stateWith('short')
    const grown = state.update({
      changes: { from: 5, insert: 'x'.repeat(COMMENT_MESSAGE_MAX_CHARS) },
    })
    expect(grown.state.doc.toString()).toBe('short')
  })

  it('lets an edit land exactly at the message limit', () => {
    const filled = stateWith('').update({
      changes: { from: 0, insert: 'x'.repeat(COMMENT_MESSAGE_MAX_CHARS) },
    })
    expect(filled.state.doc).toHaveLength(COMMENT_MESSAGE_MAX_CHARS)
  })

  it('lets a message already past the limit shrink, and refuses its growth', () => {
    const state = stateWith('x'.repeat(COMMENT_MESSAGE_MAX_CHARS + 5))
    expect(state.update({ changes: { from: 0, to: 2 } }).state.doc).toHaveLength(
      COMMENT_MESSAGE_MAX_CHARS + 3,
    )
    expect(state.update({ changes: { from: 0, insert: 'y' } }).state.doc).toHaveLength(
      COMMENT_MESSAGE_MAX_CHARS + 5,
    )
  })
})
