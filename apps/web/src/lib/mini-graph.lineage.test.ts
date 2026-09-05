// @vitest-environment node
import { afterAll, describe, expect, it } from 'vitest'
import { fc, fcTest, withDefaults } from '../test-utils/fast-check.js'
import { buildMiniGraph, type MiniGraphInput } from './mini-graph.js'

/**
 * The lineage a restore leaves, drawn as an arc from the point that was
 * restored up to the merge it produced.
 *
 * What this can and cannot see is worth stating, because the limit is the
 * data's rather than the drawing's. A restore is the only act in this
 * product that makes a document's history branch and rejoin, and it records
 * itself on the row (`restoredFrom`), so the rows alone carry every branch
 * there is to draw. A genuinely CONCURRENT edit between two peers would be
 * a branch these rows cannot express — the true DAG for that lives in the
 * frontiers each row stores, and reading it needs the oplog, which only the
 * keeper holds. Measured on a real LoroDoc, `cmpFrontiers` answers -1 / 1 /
 * 0 for ancestor, descendant and equal and `undefined` for concurrent, so
 * that door is open when a second kind of branch exists to go through it.
 */
const lineageInput = (
  versions: readonly { id: string; restoredFrom?: string }[],
): MiniGraphInput => ({
  head: 'main',
  branches: [{ name: 'main', color: '#1971c2' }],
  versions: versions.map((v, i) => ({
    id: v.id,
    branchName: 'main',
    createdAt: new Date(2_000_000_000_000 - i * 60_000).toISOString(),
    ...(v.restoredFrom === undefined ? {} : { restoredFrom: v.restoredFrom }),
  })),
})

/**
 * What the property run PRODUCED, not what it attempted.
 *
 * Both directions are counted because the assertions live inside `if`s: a
 * run that drew no arc at all satisfies every one of them and reports green,
 * which is the shape this repo's coverage rule calls a vacuous property. The
 * floors are asserted after the run, so a generator that stops reaching
 * either case fails here instead of quietly checking nothing.
 */
const tally = { arcs: 0, prunedSources: 0, refusedUpward: 0, arcSegments: 0 }

afterAll(() => {
  expect(tally.arcs, 'the run never produced an arc; the property checked nothing').toBeGreaterThan(
    20,
  )
  expect(
    tally.prunedSources,
    'the run never named a source outside the list; the pruned-source branch is unreached',
  ).toBeGreaterThan(5)
  expect(
    tally.arcSegments,
    'no arc in the run spanned more than one row; the joining segment is unproven',
  ).toBeGreaterThan(20)
  expect(
    tally.refusedUpward,
    'the run never named a source at or above its own row; the guard that refuses one is unproven',
  ).toBeGreaterThan(5)
})

describe('a restore draws an arc from what it restored', () => {
  it('links the merge row to the row it came from, and marks both ends', () => {
    const rows = buildMiniGraph(
      lineageInput([{ id: 'v4' }, { id: 'v3', restoredFrom: 'v1' }, { id: 'v2' }, { id: 'v1' }]),
    )

    const merge = rows.find((r) => r.versionId === 'v3')
    expect(merge?.restoredFrom).toBe('v1')
    // Two rows down the list, which is what the drawing needs to size the arc.
    expect(merge?.restoredFromDistance).toBe(2)
    // The far end is marked too: an arc with only one labelled end reads as
    // a line that goes nowhere.
    expect(rows.find((r) => r.versionId === 'v1')?.isRestoreSource).toBe(true)
    expect(rows.find((r) => r.versionId === 'v2')?.isRestoreSource).toBe(false)
    expect(rows.find((r) => r.versionId === 'v4')?.restoredFrom).toBeUndefined()
  })

  it('draws no arc for a source the list no longer holds', () => {
    // Pruning is real: an automatic checkpoint can be swept while the merge
    // that named it stays. An arc to nowhere is worse than no arc.
    const rows = buildMiniGraph(lineageInput([{ id: 'v2', restoredFrom: 'gone' }, { id: 'v1' }]))
    expect(rows[0]?.restoredFrom).toBeUndefined()
    expect(rows[0]?.restoredFromDistance).toBeUndefined()
    expect(rows.some((r) => r.isRestoreSource)).toBe(false)
  })

  fcTest.prop(
    [
      fc
        .array(fc.boolean(), { minLength: 1, maxLength: 12 })
        .chain((flags) =>
          fc.tuple(
            fc.constant(flags),
            fc.array(fc.nat({ max: 20 }), { minLength: flags.length, maxLength: flags.length }),
          ),
        ),
    ],
    withDefaults({ numRuns: 200 }),
  )('every arc points at a row that exists and is strictly older', ([flags, picks]) => {
    // Newest first, as the panel lists them. A restore can only have gone
    // back to something already in the list, so the source is drawn from the
    // rows BELOW the merge — and a deliberate share of the ids are made up,
    // to reach the pruned-source case above.
    const ids = flags.map((_, i) => `v${flags.length - i}`)
    const versions = ids.map((id, i) => {
      if (!flags[i]) return { id }
      const pick = picks[i] ?? 0
      // Three cases on purpose, because two of them are the ones the drawing
      // has to REFUSE and a generator that only produces valid sources
      // cannot tell whether it refuses them: a real source below, a source
      // that is no longer listed, and a source at or ABOVE this row — which
      // a restore cannot produce and a corrupt record can, and which would
      // otherwise draw an arc pointing the wrong way up the list.
      if (pick % 3 === 0) {
        const below = ids.slice(i + 1)
        if (below.length === 0) return { id }
        return { id, restoredFrom: below[pick % below.length] as string }
      }
      if (pick % 3 === 1) return { id, restoredFrom: `absent-${pick}` }
      return { id, restoredFrom: ids[pick % (i + 1)] as string }
    })

    const rows = buildMiniGraph(lineageInput(versions))
    const index = new Map(rows.map((r, i) => [r.versionId, i]))

    expect(rows.map((r) => r.versionId)).toEqual(ids)
    for (const [i, row] of rows.entries()) {
      if (row.restoredFrom === undefined) {
        expect(row.restoredFromDistance).toBeUndefined()
        const named = versions[i]?.restoredFrom
        if (named !== undefined) {
          if (index.has(named)) tally.refusedUpward += 1
          else tally.prunedSources += 1
        }
        continue
      }
      tally.arcs += 1
      const at = index.get(row.restoredFrom)
      // Exists…
      expect(at).toBeDefined()
      // …strictly older, so an arc never points at itself or upward…
      expect(at as number).toBeGreaterThan(i)
      // …and the distance is the gap the drawing spans.
      expect(row.restoredFromDistance).toBe((at as number) - i)
      // …with the far end marked…
      expect(rows[at as number]?.isRestoreSource).toBe(true)
      // …and every row in between painting its own piece, or the arc is
      // two disconnected hooks with a gap where the middle should be.
      for (let mid = i + 1; mid < (at as number); mid++) {
        expect(rows[mid]?.isRestoreArcThrough).toBe(true)
        tally.arcSegments += 1
      }
    }
    // No row claims to be a source without an arc landing on it.
    for (const [i, row] of rows.entries()) {
      if (!row.isRestoreSource) continue
      expect(rows.some((r) => r.restoredFrom === rows[i]?.versionId)).toBe(true)
    }
  })
})
