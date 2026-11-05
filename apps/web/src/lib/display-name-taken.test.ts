import { DisplayNameTakenError } from '@kamiazya/whiteboard-ports'
import { describe, expect, it } from 'vitest'
import { refuseTakenDocumentName } from './display-name-taken.js'

describe('refuseTakenDocumentName', () => {
  const sibling = { documentId: 'a', path: 'roadmap', name: 'Roadmap' }

  it("throws the keepers' own error type, so callers can branch on it", () => {
    let thrown: unknown
    try {
      refuseTakenDocumentName([sibling], { path: 'plan', name: 'roadmap', documentId: 'b' })
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(DisplayNameTakenError)
  })

  it('lets a document keep its own name', () => {
    expect(() =>
      refuseTakenDocumentName([sibling], { path: 'roadmap', name: 'Roadmap', documentId: 'a' }),
    ).not.toThrow()
  })
})
