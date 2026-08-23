import { describe, expect, it } from 'vitest'
import { fc, fcTest, withDefaults } from '../test-utils/fast-check.js'
import { fuseByRank } from './rrf.js'

describe('fuseByRank', () => {
  it('keeps a document only one retriever found', () => {
    const fused = fuseByRank([['a', 'b'], ['c']])
    expect([...fused.keys()].sort()).toEqual(['a', 'b', 'c'])
  })

  it('ranks a document both retrievers like above either list runner-up', () => {
    // 'b' is 2nd in both; 'a' and 'c' are 1st in one and absent from the other.
    const fused = fuseByRank([
      ['a', 'b'],
      ['c', 'b'],
    ])
    const order = [...fused.entries()].sort((x, y) => y[1] - x[1]).map(([id]) => id)
    expect(order[0]).toBe('b')
  })

  it('scores by rank reciprocals, never by the retrievers own scores', () => {
    // Rank 1 in one list beats rank 2 in one list, whatever scale produced them.
    const fused = fuseByRank([['top', 'second']])
    expect(fused.get('top')).toBeGreaterThan(fused.get('second') as number)
  })

  fcTest.prop(
    [
      fc.array(fc.array(fc.constantFrom('a', 'b', 'c', 'd'), { maxLength: 4 }), {
        minLength: 1,
        maxLength: 3,
      }),
    ],
    withDefaults({ numRuns: 100 }),
  )('never drops a document any retriever returned', (lists) => {
    const deduped = lists.map((l) => [...new Set(l)])
    const fused = fuseByRank(deduped)
    for (const list of deduped) for (const id of list) expect(fused.has(id)).toBe(true)
  })
})
