/**
 * The body fitting every workspace move shares: trash entries are what gives
 * way under the keeper's ceiling, and each one that does is NAMED, because
 * the browser copy is the only one of it left.
 */
import { describe, expect, it } from 'vitest'
import { fitCarriedPlanes, unconfirmedPlanes } from './carried-planes.js'

const entry = (documentId: string, size: number) => ({ documentId, bytes: 'A'.repeat(size) })

const planes = (trash: ReturnType<typeof entry>[]) => ({
  trash,
  versions: [],
  trashPaths: new Map(trash.map((each) => [each.documentId, `notes/${each.documentId}`])),
})

describe('fitCarriedPlanes', () => {
  it('leaves out a trash entry past the ceiling, names it, and keeps the ones that fit', () => {
    const fitted = fitCarriedPlanes(
      'snap',
      planes([entry('small', 10), entry('huge', 5000), entry('also-small', 10)]),
      1000,
    )
    expect(fitted.trash.map((each) => each.documentId)).toEqual(['small', 'also-small'])
    expect(fitted.leftBehind).toEqual([
      'the trashed document "notes/huge" is too large to move with the rest',
    ])
  })

  it('keeps the fitted body inside the ceiling it was given', () => {
    const limit = 400
    const fitted = fitCarriedPlanes(
      'snap',
      planes([entry('a', 150), entry('b', 150), entry('c', 150)]),
      limit,
    )
    const body = JSON.stringify({ snapshot: 'snap', trash: fitted.trash, versions: [] })
    expect(new TextEncoder().encode(body).byteLength).toBeLessThanOrEqual(limit)
    expect(fitted.trash.length).toBeGreaterThan(0)
    expect(fitted.trash.length + fitted.leftBehind.length).toBe(3)
  })

  it('carries everything and leaves nothing when it all fits', () => {
    const fitted = fitCarriedPlanes('snap', planes([entry('a', 10)]))
    expect(fitted).toEqual({ trash: [entry('a', 10)], versions: [], leftBehind: [] })
  })
})

describe('unconfirmedPlanes', () => {
  it('counts what the keeper did not read back, in the words of the keeper named', () => {
    expect(
      unconfirmedPlanes(
        { trash: [entry('a', 1), entry('b', 1)], versions: [] },
        { trashStored: ['a'], versionsKept: [] },
        'the keeper',
      ),
    ).toEqual(['1 trashed document did not reach the keeper'])
  })
})
