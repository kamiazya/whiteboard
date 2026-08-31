// The penalty rules' scoreboard, and the third instance of one pattern.
//
// `overlapAndIntrusion` carries 20 survivors, and the test that kills them is
// `edge-routing-quality.test.ts` — verified by hand: turning the body test's
// `a.y >= r.y + r.h` into `>` fails exactly that file and nothing else. It
// scores the whole layout pipeline over 2000 layouts at ~22s, so
// `vitest.stryker.config.ts` excludes it, and its findings never reach the
// module they are about. That config's own comment predicted this: "the
// mutants they would have caught still have to be caught by something, which
// is exactly the report this lane exists to produce."
//
// This is that something. `selfPenalty` is a pure function of a path and three
// rect lists, so scoring it directly over a seeded corpus costs milliseconds
// rather than seconds. Per-tier totals are PRICE, pinned exactly so a change
// that shifts cost between tiers has to say so; the grazing corpus below is
// DEBT and targets zero.
import { describe, expect, it } from 'vitest'
import { fc } from '../../test-utils/fast-check.js'
import type { Point, Rect } from './edge-rules.js'
import { PENALTY_RULES, selfPenalty, zeroPenalty } from './edge-rules.js'

const CORPUS_SEED = 8675309
const CORPUS_SIZE = 250
const LATTICE = 40

/**
 * Orthogonal walks and bodies on ONE lattice, so a path runs through a body
 * often rather than by luck — every ink term rejects by axis before it
 * measures anything, and a domain of free-form points prices nothing.
 */
const caseArb = fc.record({
  moves: fc.array(
    fc.record({
      axis: fc.constantFrom<'h' | 'v'>('h', 'v'),
      delta: fc.integer({ min: -4, max: 4 }).map((n) => n * LATTICE),
    }),
    { minLength: 1, maxLength: 8 },
  ),
  bodies: fc.array(
    fc.record({
      x: fc.integer({ min: -4, max: 4 }).map((n) => n * LATTICE),
      y: fc.integer({ min: -4, max: 4 }).map((n) => n * LATTICE),
      w: fc.integer({ min: 0, max: 3 }).map((n) => n * LATTICE),
      h: fc.integer({ min: 0, max: 3 }).map((n) => n * LATTICE),
    }),
    { minLength: 0, maxLength: 3 },
  ),
  borders: fc.array(
    fc.record({
      x: fc.integer({ min: -4, max: 4 }).map((n) => n * LATTICE),
      y: fc.integer({ min: -4, max: 4 }).map((n) => n * LATTICE),
      w: fc.integer({ min: 0, max: 3 }).map((n) => n * LATTICE),
      h: fc.integer({ min: 0, max: 3 }).map((n) => n * LATTICE),
    }),
    { minLength: 0, maxLength: 2 },
  ),
})

type Case = { path: Point[]; bodies: Rect[]; borders: Rect[]; endpoints: Rect[] }

const CORPUS: Case[] = fc.sample(caseArb, { numRuns: CORPUS_SIZE, seed: CORPUS_SEED }).map((c) => {
  let x = 0
  let y = 0
  const path: Point[] = [{ x, y }]
  for (const move of c.moves) {
    if (move.axis === 'h') x += move.delta
    else y += move.delta
    path.push({ x, y })
  }
  // Boxes around the path's own two ends. `endpoint-body-ink` reads only this
  // list, so a corpus that leaves it empty scores that rule zero and pins
  // nothing about it — which the first version of this file did.
  const around = (p: Point): Rect => ({
    x: p.x - LATTICE,
    y: p.y - LATTICE,
    w: 2 * LATTICE,
    h: 2 * LATTICE,
  })
  const last = path.at(-1) as Point
  return {
    path,
    bodies: c.bodies,
    borders: c.borders,
    endpoints: [around(path[0] as Point), around(last)],
  }
})

const tierOf = (name: string) => {
  const rule = PENALTY_RULES.find((r) => r.name === name)
  if (rule === undefined) throw new Error(`no penalty rule named ${name}`)
  return rule.tier
}

describe('penalty-rule scoreboard', () => {
  it('is measured against a corpus whose paths actually meet the bodies', () => {
    // Guard on the instrument: a corpus whose paths miss every body scores
    // zero for a cost model that charges nothing.
    const charged = CORPUS.filter((c) =>
      selfPenalty(c.path, c.bodies, c.borders, c.endpoints).some((n) => n !== 0),
    )

    expect(CORPUS).toHaveLength(CORPUS_SIZE)
    expect(charged.length).toBeGreaterThan(CORPUS_SIZE / 4)
  })

  it('scores the corpus, per declared tier', () => {
    const totals = zeroPenalty()
    for (const c of CORPUS) {
      const cost = selfPenalty(c.path, c.bodies, c.borders, c.endpoints)
      for (const [tier, value] of cost.entries()) totals[tier] = (totals[tier] as number) + value
    }

    // Read by NAME through the declared tier, so a deliberate reorder of
    // PENALTY_RULES moves the numbers rather than silently swapping them.
    expect({
      overlapAndIntrusion: totals[tierOf('overlap-and-intrusion')],
      endpointBodyInk: totals[tierOf('endpoint-body-ink')],
      borderTracing: totals[tierOf('border-tracing')],
      pathReversal: totals[tierOf('path-reversal')],
      realizedBends: totals[tierOf('realized-bends')],
    }).toEqual({
      overlapAndIntrusion: 79360,
      endpointBodyInk: 107200,
      borderTracing: 11200,
      pathReversal: 300,
      realizedBends: 581,
    })
  })

  it('charges nothing for a segment that merely grazes a body border', () => {
    // The documented exclusion: an anchor ON a neighbour's border, or a
    // segment riding the margin band, is the side-chooser's business and not
    // a tunnel. It is the reason those comparisons are `<=`/`>=` rather than
    // strict, and the corpus above cannot isolate it.
    const body: Rect = { x: 0, y: 0, w: 100, h: 100 }
    const grazing: Point[][] = [
      [
        { x: -50, y: 0 },
        { x: 150, y: 0 },
      ],
      [
        { x: -50, y: 100 },
        { x: 150, y: 100 },
      ],
      [
        { x: 0, y: -50 },
        { x: 0, y: 150 },
      ],
      [
        { x: 100, y: -50 },
        { x: 100, y: 150 },
      ],
    ]

    const charged = grazing.filter(
      (path) =>
        (selfPenalty(path, [body], [], [])[tierOf('overlap-and-intrusion')] as number) !== 0,
    )

    expect(charged).toEqual([])
  })
})
