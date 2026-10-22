import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { describe, expect, it } from 'vitest'
import {
  createReferenceContentAccount,
  REFERENCE_CHARS_BUDGET,
  REFERENCE_ELEMENTS_BUDGET,
} from './content-budget.js'

const note = (chars: number) => ({ documentId: 'n', name: 'Note', body: 'x'.repeat(chars) })

function board(nodes: number, textChars = 0) {
  return {
    documentId: 'b',
    name: 'Board',
    canvas: {
      nodes: Array.from({ length: nodes }, (_, i) =>
        textNode({ id: `t${i}`, x: 0, y: 0, width: 10, height: 10, text: 'y'.repeat(textChars) }),
      ),
      edges: [],
    },
  }
}

describe('reference content account', () => {
  it("charges a canvas's node text against the character budget", () => {
    const fits = createReferenceContentAccount()
    fits.admit(note(REFERENCE_CHARS_BUDGET - 15))
    expect(fits.admit(board(3, 5))).toHaveProperty('canvas')
    const overdrawn = createReferenceContentAccount()
    overdrawn.admit(note(REFERENCE_CHARS_BUDGET - 14))
    expect(overdrawn.admit(board(3, 5))).toEqual({ documentId: 'b', name: 'Board' })
  })

  it('admits whole what fits the character budget exactly', () => {
    const account = createReferenceContentAccount()
    const entry = note(REFERENCE_CHARS_BUDGET)
    expect(account.admit(entry)).toBe(entry)
    expect(account.closed).toBe(false)
  })

  it('answers the name of what overdraws it, and closes', () => {
    const account = createReferenceContentAccount()
    expect(account.admit(note(REFERENCE_CHARS_BUDGET - 10))).toHaveProperty('body')
    expect(account.admit(note(11))).toEqual({ documentId: 'n', name: 'Note' })
    expect(account.closed).toBe(true)
    // Closed means closed: a read after it is the cost being bounded.
    expect(account.admit(note(1))).toEqual({ documentId: 'n', name: 'Note' })
  })

  it('refuses a canvas past the element budget', () => {
    const account = createReferenceContentAccount()
    expect(account.admit(board(REFERENCE_ELEMENTS_BUDGET))).toHaveProperty('canvas')
    expect(account.admit(board(1))).toEqual({ documentId: 'b', name: 'Board' })
  })
})
