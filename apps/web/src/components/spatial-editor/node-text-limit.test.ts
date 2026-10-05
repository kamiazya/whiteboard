import { EditorState } from '@codemirror/state'
import { NODE_TEXT_MAX_CHARS } from '@kamiazya/whiteboard-model'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { describe, expect, it } from 'vitest'
import { copiedTextRefusal, nodeTextLengthLimit, pastedTextRefusal } from './node-text-limit.js'

function stateWith(doc: string): EditorState {
  return EditorState.create({ doc, extensions: [nodeTextLengthLimit] })
}

describe('nodeTextLengthLimit', () => {
  it('refuses an edit that takes the node text past the node limit', () => {
    const state = stateWith('short')
    const grown = state.update({ changes: { from: 5, insert: 'x'.repeat(NODE_TEXT_MAX_CHARS) } })
    expect(grown.state.doc.toString()).toBe('short')
  })

  it('lets an edit land exactly at the node limit', () => {
    const state = stateWith('')
    const filled = state.update({ changes: { from: 0, insert: 'x'.repeat(NODE_TEXT_MAX_CHARS) } })
    expect(filled.state.doc).toHaveLength(NODE_TEXT_MAX_CHARS)
  })

  it('lets a node already past the limit shrink, and refuses its growth', () => {
    const state = stateWith('x'.repeat(NODE_TEXT_MAX_CHARS + 5))
    expect(state.update({ changes: { from: 0, to: 2 } }).state.doc).toHaveLength(
      NODE_TEXT_MAX_CHARS + 3,
    )
    expect(state.update({ changes: { from: 0, insert: 'y' } }).state.doc).toHaveLength(
      NODE_TEXT_MAX_CHARS + 5,
    )
  })
})

describe('pastedTextRefusal', () => {
  it('lets text at the node limit through', () => {
    expect(pastedTextRefusal('x'.repeat(NODE_TEXT_MAX_CHARS))).toBeNull()
  })

  it('refuses text past the node limit, naming both lengths', () => {
    const refusal = pastedTextRefusal('x'.repeat(NODE_TEXT_MAX_CHARS + 1))
    expect(refusal).toContain('8,193')
    expect(refusal).toContain('8,192')
  })
})

describe('copiedTextRefusal', () => {
  const node = (id: string, length: number) =>
    textNode({ id, x: 0, y: 0, width: 100, height: 50, text: 'x'.repeat(length) })

  it('lets copies through when every node is within the limit', () => {
    expect(copiedTextRefusal([node('a', NODE_TEXT_MAX_CHARS), node('b', 1)], 'pasted')).toBeNull()
  })

  it('refuses copies when any node is past the limit, naming the longest', () => {
    const refusal = copiedTextRefusal(
      [node('a', 1), node('b', NODE_TEXT_MAX_CHARS + 1), node('c', NODE_TEXT_MAX_CHARS + 2)],
      'duplicated',
    )
    expect(refusal).toContain('Not duplicated')
    expect(refusal).toContain('8,194')
    expect(refusal).toContain('8,192')
  })
})
