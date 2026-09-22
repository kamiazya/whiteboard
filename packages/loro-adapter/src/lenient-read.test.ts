import { LoroDoc } from 'loro-crdt'
import { describe, expect, it } from 'vitest'
import { acceptedEntries } from './lenient-read.js'

const positive = {
  safeParse(value: unknown): { success: true; data: number } | { success: false } {
    return typeof value === 'number' && value > 0
      ? { success: true, data: value }
      : { success: false }
  },
}

describe('acceptedEntries', () => {
  it('keeps what the schema accepts, in the container key order', () => {
    const map = new LoroDoc().getMap('m')
    map.set('a', 1)
    map.set('b', 2)
    expect(acceptedEntries(map, positive)).toEqual([1, 2])
  })

  // A record the schema rejects costs that record and nothing beside it.
  it('drops a rejected record and keeps its neighbours', () => {
    const map = new LoroDoc().getMap('m')
    map.set('a', 1)
    map.set('b', 'not a number')
    map.set('c', 3)
    expect(acceptedEntries(map, positive)).toEqual([1, 3])
  })

  // A thread or a proposal written without its child container — old or
  // foreign data — reads as having none rather than failing the whole read.
  it('answers nothing for an absent container', () => {
    expect(acceptedEntries(undefined, positive)).toEqual([])
  })
})
