import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { MinHeap } from './min-heap.js'

/** Drains the heap, returning what it handed back in order. */
function drain(heap: MinHeap): { cost: number; value: number }[] {
  const out: { cost: number; value: number }[] = []
  for (;;) {
    const top = heap.pop()
    if (top === undefined) return out
    out.push(top)
  }
}

describe('MinHeap', () => {
  it('is empty before anything is pushed, and says so rather than throwing', () => {
    const heap = new MinHeap()
    expect(heap.size).toBe(0)
    expect(heap.pop()).toBeUndefined()
  })

  it.each([
    ['one entry', [[5, 50]]],
    [
      'already ordered',
      [
        [1, 10],
        [2, 20],
        [3, 30],
      ],
    ],
    [
      'reversed',
      [
        [3, 30],
        [2, 20],
        [1, 10],
      ],
    ],
    [
      'equal costs',
      [
        [1, 10],
        [1, 11],
        [1, 12],
      ],
    ],
  ])('pops %s lowest cost first', (_name, entries) => {
    const heap = new MinHeap()
    for (const [cost, value] of entries as [number, number][]) heap.push(cost, value)
    const costs = drain(heap).map((e) => e.cost)
    expect(costs).toEqual([...costs].sort((a, b) => a - b))
  })

  it('pops in non-decreasing cost order, and returns every pushed pair exactly once', () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(fc.integer({ min: -50, max: 50 }), fc.integer({ min: 0, max: 999 })), {
          maxLength: 60,
        }),
        (entries) => {
          const heap = new MinHeap()
          for (const [cost, value] of entries) heap.push(cost, value)
          expect(heap.size).toBe(entries.length)
          const popped = drain(heap)

          // Order: non-decreasing COST. Ties are deliberately unordered — the
          // router relies on that (several routes can be optimal), so a
          // stronger assertion here would pin behaviour the heap does not have.
          for (let i = 1; i < popped.length; i++) {
            expect((popped[i] as { cost: number }).cost).toBeGreaterThanOrEqual(
              (popped[i - 1] as { cost: number }).cost,
            )
          }

          // Contents: the same multiset that went in, so nothing is dropped or
          // duplicated by a sift. Sorted because the tie order is not pinned.
          const key = (e: { cost: number; value: number }) => `${e.cost}:${e.value}`
          expect(popped.map(key).sort()).toEqual(
            entries.map(([cost, value]) => `${cost}:${value}`).sort(),
          )
          expect(heap.size).toBe(0)
        },
      ),
      { numRuns: 2000 },
    )
  })
})
