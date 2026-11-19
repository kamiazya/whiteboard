import { fc, withDefaults } from '@kamiazya/whiteboard-model/test-utils'
import { describe, expect, it } from 'vitest'
import { compareVersions, intersectVersions, type VersionVector } from './version-vector.js'

// A few peers and small counters make the interesting arrangements (equal,
// ordered, concurrent, disjoint) common instead of vanishingly rare.
const vector = fc
  .dictionary(fc.constantFrom('1', '2', '3', '4'), fc.integer({ min: 0, max: 4 }))
  .map((record) => new Map(Object.entries(record)) as VersionVector)

// Independent draws are almost never equal, so half the pairs are a vector and
// its copy.
const pair = fc.oneof(
  fc.tuple(vector, vector),
  vector.map((v): [VersionVector, VersionVector] => [v, new Map(v)]),
)

describe('compareVersions', () => {
  it('orders by every peer, reading a missing peer as nothing seen', () => {
    const none = new Map<string, number>()
    const one = new Map([['1', 2]])
    const both = new Map([
      ['1', 2],
      ['2', 1],
    ])
    expect(compareVersions(one, one)).toBe('equal')
    expect(compareVersions(none, one)).toBe('before')
    expect(compareVersions(both, one)).toBe('after')
    expect(compareVersions(one, new Map([['2', 1]]))).toBe('concurrent')
    expect(compareVersions(new Map([['1', 0]]), none)).toBe('equal')
  })

  it('answers the opposite order when its arguments swap', () => {
    const opposite = { before: 'after', after: 'before', equal: 'equal', concurrent: 'concurrent' }
    fc.assert(
      fc.property(pair, ([a, b]) => {
        expect(compareVersions(b, a)).toBe(opposite[compareVersions(a, b)])
      }),
      withDefaults({ numRuns: 100 }),
    )
  })

  it('reaches every order, so the property above is not vacuous', () => {
    const seen = new Set<string>()
    fc.assert(
      fc.property(pair, ([a, b]) => {
        seen.add(compareVersions(a, b))
      }),
      withDefaults({ numRuns: 300 }),
    )
    expect([...seen].sort()).toEqual(['after', 'before', 'concurrent', 'equal'])
  })
})

describe('intersectVersions', () => {
  it('keeps, per peer, the fewest ops either has seen, and drops a peer only one has', () => {
    const a = new Map([
      ['1', 5],
      ['2', 3],
    ])
    const b = new Map([
      ['1', 2],
      ['3', 9],
    ])
    expect(intersectVersions(a, b)).toEqual(new Map([['1', 2]]))
  })

  it('is commutative and idempotent, and no later than either side', () => {
    fc.assert(
      fc.property(vector, vector, (a, b) => {
        const meet = intersectVersions(a, b)
        expect(compareVersions(meet, intersectVersions(b, a))).toBe('equal')
        expect(compareVersions(intersectVersions(a, a), a)).toBe('equal')
        expect(['before', 'equal']).toContain(compareVersions(meet, a))
        expect(['before', 'equal']).toContain(compareVersions(meet, b))
      }),
      withDefaults({ numRuns: 100 }),
    )
  })

  it('is the latest version no later than both', () => {
    fc.assert(
      fc.property(vector, vector, vector, (a, b, c) => {
        const bound = ['before', 'equal']
        if (bound.includes(compareVersions(c, a)) && bound.includes(compareVersions(c, b))) {
          expect(bound).toContain(compareVersions(c, intersectVersions(a, b)))
        }
      }),
      withDefaults({ numRuns: 400 }),
    )
  })
})
