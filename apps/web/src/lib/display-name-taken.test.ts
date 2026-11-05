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

  it('quotes the sibling as it is called, not the variant that was typed', () => {
    expect(() =>
      refuseTakenDocumentName([sibling], { path: 'plan', name: 'ROADMAP ', documentId: 'b' }),
    ).toThrow(
      'Another document here is already called "Roadmap". Choose a name no other document here has.',
    )
  })

  it('lets a document keep its own name', () => {
    expect(() =>
      refuseTakenDocumentName([sibling], { path: 'roadmap', name: 'Roadmap', documentId: 'a' }),
    ).not.toThrow()
  })

  it('reads a blank-named sibling as showing its segment', () => {
    const blank = { documentId: 'a', path: 'roadmap', name: '  ' }
    expect(() =>
      refuseTakenDocumentName([blank], { path: 'plan', name: 'Roadmap', documentId: 'b' }),
    ).toThrow('Another document here is already called "roadmap".')
  })
})
