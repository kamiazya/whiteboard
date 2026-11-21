import { describe, expect, it } from 'vitest'
import { compactionCutOfRecord } from './compaction-cut.js'

type Entries = { peer: string; counter: number }[]
const entries = (...pairs: [string, number][]): Entries =>
  pairs.map(([peer, counter]) => ({ peer, counter }))

/** A record whose history answers each encoded point (its first byte) with the version it names. */
function record(
  versions: Record<number, Entries>,
  root: Entries = [],
): Parameters<typeof compactionCutOfRecord>[0] {
  return {
    versionAt: (point) => {
      const found = versions[point[0] as number]
      if (found === undefined) throw new Error('a point the record does not hold')
      return { encoded: new Uint8Array(), encodedFrontiers: point, entries: found }
    },
    shallowRootVersion: () => root,
  }
}

describe('the version a compaction cuts the record at', () => {
  it('is what every point has seen', () => {
    const cut = compactionCutOfRecord(
      record({ 1: entries(['a', 5], ['b', 2]), 2: entries(['a', 3], ['b', 4]) }),
      [new Uint8Array([1]), new Uint8Array([2])],
    )

    expect(cut).toEqual(expect.arrayContaining(entries(['a', 3], ['b', 2])))
    expect(cut).toHaveLength(2)
  })

  it('is nothing when there is no point, or none every point shares', () => {
    expect(compactionCutOfRecord(record({}), [])).toBeNull()
    expect(
      compactionCutOfRecord(record({ 1: entries(['a', 1]), 2: entries(['b', 1]) }), [
        new Uint8Array([1]),
        new Uint8Array([2]),
      ]),
    ).toBeNull()
  })

  it('is nothing when a point is one the record does not hold', () => {
    expect(
      compactionCutOfRecord(record({ 1: entries(['a', 1]) }), [
        new Uint8Array([1]),
        new Uint8Array([9]),
      ]),
    ).toBeNull()
  })

  it('is nothing when it would fall before the root the record was last cut at', () => {
    const history = record({ 1: entries(['a', 3]) }, entries(['a', 8]))
    expect(compactionCutOfRecord(history, [new Uint8Array([1])])).toBeNull()
  })

  it('is taken when it stands after the root', () => {
    const history = record({ 1: entries(['a', 9]) }, entries(['a', 8]))
    expect(compactionCutOfRecord(history, [new Uint8Array([1])])).toEqual(entries(['a', 9]))
  })
})
