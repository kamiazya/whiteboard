import { type Frontiers, LoroDoc } from 'loro-crdt'
import { describe, expect, it } from 'vitest'
import { compactionCut as compactionCutOfVectors } from './compaction-cut.js'
import { compactionCutOverDoc as compactionCut } from './test-utils/crdt-mechanics-oracle.js'

function write(doc: LoroDoc, key: string, value: number): Frontiers {
  doc.getMap('m').set(key, value)
  doc.commit()
  return doc.frontiers()
}

/** Every point still checks out once the record is cut at `cut` and reopened. */
function everyPointSurvives(doc: LoroDoc, cut: Frontiers, points: readonly Frontiers[]): boolean {
  const reopened = new LoroDoc()
  reopened.import(doc.export({ mode: 'shallow-snapshot', frontiers: cut }))
  return points.every((point) => {
    try {
      reopened.checkout(point)
      return true
    } catch {
      return false
    }
  })
}

describe('compactionCut', () => {
  it('is the oldest point on one line of history, whatever order the points come in', () => {
    const doc = new LoroDoc()
    const first = write(doc, 'a', 1)
    const second = write(doc, 'b', 2)
    const head = write(doc, 'c', 3)
    expect(compactionCut(doc, [head, first, second])).toEqual(first)
  })

  it('is the fork point for two versions on concurrent branches', () => {
    const a = new LoroDoc()
    a.setPeerId(1n)
    const fork = write(a, 'base', 0)
    const b = LoroDoc.fromSnapshot(a.export({ mode: 'snapshot' }))
    b.setPeerId(2n)
    const onB = write(b, 'b', 1)
    const onA = write(a, 'a', 1)
    a.import(b.export({ mode: 'update' }))

    const cut = compactionCut(a, [onA, onB])
    expect(cut).toEqual(fork)
    expect(cut !== null && everyPointSurvives(a, cut, [onA, onB])).toBe(true)
  })

  it('is no cut when the versions share no op', () => {
    const a = new LoroDoc()
    a.setPeerId(1n)
    const onA = write(a, 'a', 1)
    const b = new LoroDoc()
    b.setPeerId(2n)
    const onB = write(b, 'b', 1)
    a.import(b.export({ mode: 'update' }))
    expect(compactionCut(a, [onA, onB])).toBeNull()
  })

  it('is no cut for no versions, or for a point the record does not hold', () => {
    const doc = new LoroDoc()
    const held = write(doc, 'a', 1)
    expect(compactionCut(doc, [])).toBeNull()
    expect(compactionCut(doc, [held, [{ peer: '424242', counter: 7 }]])).toBeNull()
  })

  it('is no cut when a point lies before the shallow root the record already has', () => {
    const doc = new LoroDoc()
    const early = write(doc, 'a', 1)
    const root = write(doc, 'b', 2)
    const head = write(doc, 'c', 3)
    const shallow = new LoroDoc()
    shallow.import(doc.export({ mode: 'shallow-snapshot', frontiers: root }))
    expect(compactionCut(shallow, [early, head])).toBeNull()
    expect(compactionCut(shallow, [root, head])).toEqual(root)
  })
})

describe('compactionCut over plain version vectors', () => {
  const at = (...pairs: Array<[string, number]>) => new Map(pairs)
  const noRoot = at()

  it('is the per-peer fewest ops any point has seen', () => {
    expect(
      compactionCutOfVectors([at(['1', 5], ['2', 3]), at(['1', 2], ['2', 9])], noRoot),
    ).toEqual(at(['1', 2], ['2', 3]))
  })

  it('is no cut for no points, or for points that share no op', () => {
    expect(compactionCutOfVectors([], noRoot)).toBeNull()
    expect(compactionCutOfVectors([at(['1', 2]), at(['2', 2])], noRoot)).toBeNull()
  })

  it('is the root itself when the points all stand at it, and no cut before it', () => {
    const root = at(['1', 4])
    expect(compactionCutOfVectors([at(['1', 4]), at(['1', 8])], root)).toEqual(root)
    expect(compactionCutOfVectors([at(['1', 3]), at(['1', 8])], root)).toBeNull()
  })

  it('is no cut concurrent with the root, which no record can check out', () => {
    expect(compactionCutOfVectors([at(['2', 3])], at(['1', 4]))).toBeNull()
  })
})
