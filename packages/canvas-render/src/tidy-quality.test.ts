// Tidy's scoreboard. It exists because most of `tidy.ts` is a QUALITY
// heuristic wearing correctness clothing, and the correctness tests beside it
// cannot see a change to it at all.
//
// Measured: forcing the overlap-resolution axis to `'x'` — deleting the
// penetration comparison that chooses it — leaves every test in
// `tidy.test.ts` green, separation, grid-snapping, idempotence and
// determinism included, while total displacement over this corpus goes from
// 51647 to 77469. That is a 50% regression in how far tidy drags a person's
// boxes, and nothing in the repo would have said a word.
//
// So: DEBT metrics target zero and are the rules tidy promises. PRICE metrics
// have no target — they exist so that a change buying one with another cannot
// do it quietly. Both are pinned EXACTLY rather than as ceilings, because an
// improvement should be as loud as a regression: the number moves, and
// whoever moved it says why in the diff. This is not a golden to regenerate.
import { describe, expect, it } from 'vitest'
import { fc } from './test-utils/fast-check.js'
import type { TidyNode } from './tidy.js'
import { tidyNodes } from './tidy.js'

const TIDY_MARGIN_PX = 24
const TIDY_GRID_PX = 8

/**
 * The metrics are computed here, from geometry, and never by asking `tidy.ts`
 * anything — the same independent-oracle rule the routing scoreboard follows.
 * A metric that called the production helper could be satisfied by a broken
 * rule agreeing with itself.
 */
type Rect = { x: number; y: number; w: number; h: number }
const rectOf = (n: TidyNode): Rect => ({ x: n.x, y: n.y, w: n.width, h: n.height })
const overlapsWithMargin = (a: Rect, b: Rect) =>
  a.x < b.x + b.w + TIDY_MARGIN_PX &&
  b.x < a.x + a.w + TIDY_MARGIN_PX &&
  a.y < b.y + b.h + TIDY_MARGIN_PX &&
  b.y < a.y + a.h + TIDY_MARGIN_PX

/**
 * A fixed corpus, drawn once from a pinned seed. Boxes are large relative to
 * the field ON PURPOSE: tidy's whole job only happens when things crowd, and
 * a corpus that spreads them out scores beautifully while exercising nothing.
 */
const CORPUS_SEED = 4242
const CORPUS_SIZE = 300

const boardArb = fc.array(
  fc.record({
    x: fc.integer({ min: 0, max: 640 }),
    y: fc.integer({ min: 0, max: 480 }),
    w: fc.constantFrom(60, 100, 140),
    h: fc.constantFrom(40, 60),
  }),
  { minLength: 2, maxLength: 12 },
)

const CORPUS: TidyNode[][] = fc
  .sample(boardArb, { numRuns: CORPUS_SIZE, seed: CORPUS_SEED })
  .map((rects) =>
    rects.map((r, i) => ({
      id: `n${i}`,
      type: 'text' as const,
      x: r.x,
      y: r.y,
      width: r.w,
      height: r.h,
    })),
  )

/**
 * The same boards with a GROUP wrapping their first few members, and one node
 * locked. Groups are the half of `tidy.ts` the plain corpus cannot reach at
 * all — a group only scoops what its box CONTAINS, and independently drawn
 * boxes contain one another almost never, so the enclosing box is computed
 * from the members it is meant to hold.
 */
const GROUPED_CORPUS: { nodes: TidyNode[]; lockedId: string }[] = CORPUS.map((nodes, i) => {
  const wrapped = nodes.slice(0, 2 + (i % 3))
  const x = Math.min(...wrapped.map((n) => n.x))
  const y = Math.min(...wrapped.map((n) => n.y))
  const right = Math.max(...wrapped.map((n) => n.x + n.width))
  const bottom = Math.max(...wrapped.map((n) => n.y + n.height))
  const group: TidyNode = {
    id: 'grp',
    type: 'group',
    x,
    y,
    width: right - x,
    height: bottom - y,
  }
  return { nodes: [group, ...nodes], lockedId: (nodes.at(-1) as TidyNode).id }
})

describe('tidy quality scoreboard', () => {
  it('is measured against a corpus that actually crowds', () => {
    // A guard on the instrument itself: a corpus whose boards never overlap
    // would report a perfect score for a tidy that does nothing, and the
    // reader would be sent to the wrong file.
    const crowded = CORPUS.filter((nodes) =>
      nodes.some((a, i) =>
        nodes.slice(i + 1).some((b) => overlapsWithMargin(rectOf(a), rectOf(b))),
      ),
    )

    expect(CORPUS).toHaveLength(CORPUS_SIZE)
    expect(crowded.length).toBeGreaterThan(CORPUS_SIZE / 2)
  })

  it('scores the corpus', () => {
    let stillOverlapping = 0
    let offGrid = 0
    let noOpMoves = 0
    let movedNodes = 0
    let displacement = 0
    let maxDisplacement = 0

    for (const nodes of CORPUS) {
      const byId = new Map(nodes.map((n) => [n.id, n]))
      const moves = tidyNodes(nodes)
      const after = nodes.map((n) => {
        const m = moves.find((mv) => mv.id === n.id)
        return m === undefined ? n : { ...n, x: m.x, y: m.y }
      })

      for (let i = 0; i < after.length; i++) {
        for (let j = i + 1; j < after.length; j++) {
          if (overlapsWithMargin(rectOf(after[i] as TidyNode), rectOf(after[j] as TidyNode))) {
            stillOverlapping++
          }
        }
      }
      for (const m of moves) {
        const before = byId.get(m.id) as TidyNode
        if (m.x % TIDY_GRID_PX !== 0 || m.y % TIDY_GRID_PX !== 0) offGrid++
        if (m.x === before.x && m.y === before.y) noOpMoves++
        movedNodes++
        const d = Math.abs(m.x - before.x) + Math.abs(m.y - before.y)
        displacement += d
        maxDisplacement = Math.max(maxDisplacement, d)
      }
    }

    expect({
      // DEBT — the rules tidy promises. Each targets zero.
      stillOverlapping,
      offGrid,
      noOpMoves,
      // PRICE — what tidying costs the author's layout. No target; they are
      // here so that a change trading one for another has to say so.
      movedNodes,
      displacement,
      maxDisplacement,
    }).toEqual({
      stillOverlapping: 0,
      offGrid: 0,
      noOpMoves: 0,
      movedNodes: 1940,
      displacement: 51647,
      maxDisplacement: 469,
    })
  })

  it('scores the same corpus with groups and a lock', () => {
    let stillOverlapping = 0
    let lockedMoved = 0
    let unitTornApart = 0
    let movedNodes = 0
    let displacement = 0

    for (const { nodes, lockedId } of GROUPED_CORPUS) {
      const byId = new Map(nodes.map((n) => [n.id, n]))
      const moves = tidyNodes(nodes, { locked: (id) => id === lockedId })
      const delta = new Map(
        moves.map((m) => [
          m.id,
          `${m.x - (byId.get(m.id) as TidyNode).x},${m.y - (byId.get(m.id) as TidyNode).y}`,
        ]),
      )

      if (delta.has(lockedId)) lockedMoved++

      // A group and everything its box holds is ONE unit, so they move by the
      // same vector or not at all. A unit torn apart is the defect the
      // outermost-rooted single scoop exists to prevent, and it is invisible
      // to a board with no groups on it.
      const group = nodes[0] as TidyNode
      const members = nodes.filter(
        (n) =>
          n.id !== lockedId &&
          n.x >= group.x &&
          n.y >= group.y &&
          n.x + n.width <= group.x + group.width &&
          n.y + n.height <= group.y + group.height,
      )
      const vectors = new Set(members.map((m) => delta.get(m.id) ?? '0,0'))
      if (vectors.size > 1) unitTornApart++

      const after = nodes.map((n) => {
        const m = moves.find((mv) => mv.id === n.id)
        return m === undefined ? n : { ...n, x: m.x, y: m.y }
      })
      // The group's own box is not a thing a reader sees a collision with —
      // it is drawn around its members — so overlap is scored on the members.
      const bodies = after.filter((n) => n.type !== 'group')
      for (let i = 0; i < bodies.length; i++) {
        for (let j = i + 1; j < bodies.length; j++) {
          if (overlapsWithMargin(rectOf(bodies[i] as TidyNode), rectOf(bodies[j] as TidyNode))) {
            stillOverlapping++
          }
        }
      }
      for (const m of moves) {
        movedNodes++
        const before = byId.get(m.id) as TidyNode
        displacement += Math.abs(m.x - before.x) + Math.abs(m.y - before.y)
      }
    }

    expect({
      // DEBT
      lockedMoved,
      unitTornApart,
      // PRICE — including the overlap that a locked obstacle can force tidy
      // to accept, which is why it is not debt here.
      stillOverlapping,
      movedNodes,
      displacement,
    }).toEqual({
      lockedMoved: 0,
      unitTornApart: 0,
      // Non-zero by design, which is why it is priced rather than owed:
      // members of one group unit keep their relative positions, so a pair
      // that overlapped inside the group still does, and a locked node is an
      // obstacle tidy cannot move out of the way. The number is here so that
      // a change making it WORSE has to say so.
      stillOverlapping: 241,
      movedNodes: 1934,
      displacement: 65160,
    })
  })
})
