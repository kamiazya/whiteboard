import { describe, expect, it } from 'vitest'
import {
  autoVersionsOverCap,
  carriedAutoVersionsOverCap,
  MAX_AUTO_PER_DOCUMENT,
  restorePointOptions,
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
  const row = (id: string, auto: boolean, restoredFrom: string | null = null) => ({
    id,
    auto,
    restoredFrom,
  })

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

  it('the sandwich spares lineage on both ends', () => {
    // A restore's merge point and the point it named, both automatic and both
    // bracketed by manual saves: exactly the rows the sandwich would take.
    expect(
      sandwichedAutoVersionIds([
        row('m1', false),
        row('named', true),
        row('m2', false),
        row('merge', true, 'named'),
        row('plain', true),
        row('m3', false),
      ]),
    ).toEqual(['plain'])
  })
})

describe('restorePointOptions', () => {
  it('records a restore point as automatic, naming what it restored', () => {
    expect(restorePointOptions('v-past')).toEqual({ auto: true, restoredFrom: 'v-past' })
  })
})

describe('carriedAutoVersionsOverCap', () => {
  const row = (id: string, restoredFrom: string | null = null) => ({ id, restoredFrom })

  it('makes room from the oldest carried rows, however new they are against the own ones', () => {
    // Newest first: two carried rows outrank both of the keeper's own.
    const autos = [row('c2'), row('c1'), row('own2'), row('own1')]
    expect(carriedAutoVersionsOverCap(autos, new Set(['c1', 'c2']), new Set(), 3)).toEqual(['c1'])
  })

  it('removes no own row, even when the carried ones cannot make up the excess', () => {
    const autos = [row('c1'), row('own3'), row('own2'), row('own1')]
    expect(carriedAutoVersionsOverCap(autos, new Set(['c1']), new Set(), 2)).toEqual(['c1'])
  })

  it('removes nothing within the cap, and spares carried lineage', () => {
    expect(carriedAutoVersionsOverCap([row('c1')], new Set(['c1']), new Set(), 1)).toEqual([])
    const autos = [row('c2', 'own1'), row('c1'), row('own1')]
    expect(carriedAutoVersionsOverCap(autos, new Set(['c1', 'c2']), new Set(['own1']), 1)).toEqual([
      'c1',
    ])
  })
})
