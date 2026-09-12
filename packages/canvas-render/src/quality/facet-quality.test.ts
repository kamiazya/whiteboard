// The facet-vocabulary SCOREBOARD (ADR-0033): what each corpus board says
// with APPEARANCE, pinned EXACTLY, beside the drawing and composition
// scoreboards rather than inside either.
//
// **Read the first reading before reading a row.** Every board in this
// corpus — the hand-drawn references included — spends NOTHING on the
// channel: one treatment, distance 0, and every construct it declares owed
// as `deficit`. That is not a defect in eight particular boards, it is a
// whole channel nobody has used, and the references share it because they
// were drawn to be references for GEOMETRY.
//
// So this scoreboard starts as a BASELINE rather than as a set of owes to
// burn down, and the instrument-validity tests the other two carry — a
// reference beats its draft, tidy never adds debt — are deliberately absent
// here: with every board identical on every column they would pass
// vacuously, which is the shape ADR-0031 §7 warns about. What is pinned
// instead is that the corpus is uniform, so the first board to spend
// anything is loud.
import { describe, expect, it } from 'vitest'
import { DRAWING_CORPUS } from '../test-utils/drawing-corpus.js'
import { type FacetScore, scoreFacets } from './facet-score.js'

const scores = new Map(DRAWING_CORPUS.map((c) => [c.name, scoreFacets(c.canvas)]))
const of = (name: string) => scores.get(name) as FacetScore

/**
 * Every board reads this today: nothing spent, so nothing to tell apart.
 *
 * The channel columns make that literal, and reading them across the whole
 * corpus said something about the CORPUS rather than about any board in it:
 * all eleven leave BOTH channels unused. These are geometry fixtures — not
 * one of them is dressed — so the contested-channel case they were added for
 * cannot arise here at all, and the constant's name has been accurate the
 * whole time without anyone noticing how completely.
 *
 * Where that case does live is the eval lane, whose boards a model draws and
 * colours. `facet-score.test.ts` holds the calibration; this file will keep
 * reporting zero until the corpus gains a dressed board, and a zero here is
 * therefore evidence of nothing.
 */
const UNSPENT = {
  deficit: 0,
  overload: 0,
  excess: 0,
  distance: 0,
  treatments: 1,
  redundancy: 0,
  channels: { colour: 'unused', shape: 'unused' },
  contested: 0,
} as const

describe('facet vocabulary across the corpus', () => {
  it('reports every board', () => {
    expect(Object.fromEntries(scores)).toEqual({
      // Three frames (Clients, Services, Storage), so three constructs, and
      // the drawing distinguishes none of them by appearance.
      'architecture/reference': { partitions: 1, constructs: 3, ...UNSPENT, deficit: 3 },
      // The draft's fourth construct is the boxes no frame holds.
      'architecture/drafted': { partitions: 1, constructs: 4, ...UNSPENT, deficit: 4 },
      'architecture/tidied': { partitions: 1, constructs: 3, ...UNSPENT, deficit: 3 },
      // The BLIND SPOT, live in the corpus rather than only in a unit test:
      // a sequence diagram has no frame and one node kind, so it declares no
      // distinction and every column is silent — on a board that may still
      // be drawn well or badly. `drawing-score` and the composition axis are
      // what read these three.
      'sequence/reference': { partitions: 0, constructs: 0, ...UNSPENT },
      'sequence/drafted': { partitions: 0, constructs: 0, ...UNSPENT },
      'sequence/tidied': { partitions: 0, constructs: 0, ...UNSPENT },
      'fixture/architecture': { partitions: 1, constructs: 2, ...UNSPENT, deficit: 2 },
      // The lane boards are what a MODEL drew through the tool surface, and
      // they read exactly like the hand-drawn ones: the channel is unspent
      // by everyone, not only by the model.
      'lane/architecture': { partitions: 1, constructs: 3, ...UNSPENT, deficit: 3 },
      'lane/architecture-tidied': { partitions: 1, constructs: 3, ...UNSPENT, deficit: 3 },
      'lane/insert': { partitions: 1, constructs: 2, ...UNSPENT, deficit: 2 },
      'lane/insert-roomy': { partitions: 1, constructs: 2, ...UNSPENT, deficit: 2 },
    })
  })

  it('owes every construct it declares, on every board that declares one', () => {
    // The finding stated as a claim rather than as eleven rows, so it fails
    // the moment any board spends anything — which is the event this axis
    // exists to notice, and the reason the number is worth carrying at all.
    for (const [name, s] of scores) {
      expect(`${name}: ${s.deficit}/${s.constructs}`).toBe(
        `${name}: ${s.constructs}/${s.constructs}`,
      )
    }
  })

  it('spends one treatment across the whole corpus', () => {
    // 22 constructs over 8 boards that declare something, and one appearance
    // among them. Neither `overload` nor `excess` can be non-zero while this
    // holds — you cannot misuse a vocabulary you have not opened.
    const constructs = [...scores.values()].reduce((sum, s) => sum + s.constructs, 0)
    const spent = [...scores.values()].reduce((sum, s) => sum + (s.treatments - 1), 0)
    expect({ constructs, spent }).toEqual({ constructs: 22, spent: 0 })
  })

  it('reads a board that DOES spend the channel, so the columns are not dead', () => {
    // The corpus cannot demonstrate the instrument working, so one board is
    // recoloured here rather than added to the corpus: inventing the fixture
    // that justifies a change is how a fixture becomes the convention by
    // accident (ADR-0032's guide-line reading), and this is a check that the
    // pins above are pinning something.
    const board = of('architecture/reference')
    expect(board.deficit).toBe(3)
    const canvas = DRAWING_CORPUS.find((c) => c.name === 'architecture/reference')?.canvas
    const frames = (canvas?.nodes ?? []).filter((n) => n.type === 'group')
    const inFirstFrame = (n: { x: number; y: number; width: number; height: number }) => {
      const f = frames[0]
      return (
        f !== undefined &&
        n.x >= f.x &&
        n.y >= f.y &&
        n.x + n.width <= f.x + f.width &&
        n.y + n.height <= f.y + f.height
      )
    }
    const recoloured = {
      ...canvas,
      nodes: (canvas?.nodes ?? []).map((n) =>
        n.type !== 'group' && inFirstFrame(n) ? { ...n, color: '4' } : n,
      ),
    } as NonNullable<typeof canvas>
    const after = scoreFacets(recoloured)
    expect(after.deficit).toBe(2)
    expect([after.treatments, after.distance, after.overload, after.excess]).toEqual([2, 1, 0, 0])
  })
})
