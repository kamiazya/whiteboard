import { describe, expect, it } from 'vitest'
import {
  autoVersionsOverCap,
  MAX_AUTO_PER_DOCUMENT,
  sandwichedAutoVersionIds,
} from './retention.js'

describe('autoVersionsOverCap', () => {
  const autos = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ id: `a${i}`, restoredFrom: null }))

  it('keeps everything at or under the cap', () => {
    expect(autoVersionsOverCap(autos(MAX_AUTO_PER_DOCUMENT), new Set())).toEqual([])
  })

  it('removes the oldest past the cap, newest first being kept', () => {
    expect(autoVersionsOverCap(autos(MAX_AUTO_PER_DOCUMENT + 2), new Set())).toEqual([
      `a${MAX_AUTO_PER_DOCUMENT}`,
      `a${MAX_AUTO_PER_DOCUMENT + 1}`,
    ])
  })

  it('spares lineage on both ends: a merge point and the point it named', () => {
    const rows = [
      ...autos(3),
      { id: 'merge', restoredFrom: 'named' },
      { id: 'named', restoredFrom: null },
      { id: 'plain', restoredFrom: null },
    ]
    expect(autoVersionsOverCap(rows, new Set(['named']), 2)).toEqual(['a2', 'plain'])
  })
})

describe('sandwichedAutoVersionIds', () => {
  const row = (id: string, auto: boolean) => ({ id, auto })

  it('removes the automatic rows strictly between the first and last manual save', () => {
    expect(
      sandwichedAutoVersionIds([
        row('a1', true),
        row('m1', false),
        row('a2', true),
        row('a3', true),
        row('m2', false),
        row('a4', true),
      ]),
    ).toEqual(['a2', 'a3'])
  })

  it('never removes a manual save that sits inside the sandwich', () => {
    expect(
      sandwichedAutoVersionIds([
        row('m1', false),
        row('a1', true),
        row('m2', false),
        row('m3', false),
      ]),
    ).toEqual(['a1'])
  })

  it('leaves a document with fewer than two manual saves alone', () => {
    expect(sandwichedAutoVersionIds([row('a1', true), row('m1', false)])).toEqual([])
    expect(sandwichedAutoVersionIds([row('a1', true), row('a2', true)])).toEqual([])
  })
})
