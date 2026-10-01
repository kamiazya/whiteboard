import { describe, expect, it } from 'vitest'
import { partialDeleteMessage, reofferFailures } from './pending-delete.js'

const lookup = (path: string) =>
  ({
    alpha: { displayName: 'Alpha board', kind: 'spatial' as const },
    beta: { displayName: 'Beta note', kind: 'markdown' as const },
    gamma: { displayName: 'Gamma' },
  })[path]

describe('reofferFailures', () => {
  it('names a lone survivor as the list shows it, with its kind', () => {
    expect(reofferFailures(['beta'], lookup)).toEqual({
      paths: ['beta'],
      displayName: 'Beta note',
      kind: 'markdown',
    })
  })

  it('falls back to the path for a lone survivor the list no longer holds', () => {
    // Never a count: `Delete "1 documents"?` is the count of the attempt.
    expect(reofferFailures(['vanished'], lookup)).toEqual({
      paths: ['vanished'],
      displayName: 'vanished',
    })
  })

  it('omits kind rather than carrying undefined when the list records none', () => {
    expect(reofferFailures(['gamma'], lookup)).toEqual({ paths: ['gamma'], displayName: 'Gamma' })
  })

  it('counts several survivors and copies the list it was given', () => {
    const failed = ['alpha', 'beta']
    const offered = reofferFailures(failed, lookup)
    expect(offered).toEqual({ paths: ['alpha', 'beta'], displayName: '2 documents' })
    expect(offered.paths).not.toBe(failed)
  })
})

describe('partialDeleteMessage', () => {
  it('reports the count when only some failed', () => {
    expect(partialDeleteMessage(1, 3, new Error('nope'), 'Failed.')).toBe(
      '1 of 3 could not be deleted.',
    )
  })

  it("reports the keeper's own reason when all failed", () => {
    expect(partialDeleteMessage(2, 2, new Error('daemon said no'), 'Failed.')).toBe(
      'daemon said no',
    )
  })

  it('falls back to the given sentence when all failed with no Error to quote', () => {
    expect(
      partialDeleteMessage(2, 2, null, 'Failed to delete the document from this browser.'),
    ).toBe('Failed to delete the document from this browser.')
  })
})
