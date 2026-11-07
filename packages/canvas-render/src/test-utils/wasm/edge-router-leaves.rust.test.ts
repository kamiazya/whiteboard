import { type EdgeSide, edgeSideSchema } from '@kamiazya/whiteboard-model'
import { afterAllFloor } from '@kamiazya/whiteboard-model/test-utils'
import { describe, expect, it } from 'vitest'
import {
  outwardNormal,
  type Point,
  type Rect,
  segmentCrossesRect,
  sidePointAt,
} from '../../layout/edges/edge-geometry.js'
import {
  deepenedCorridor,
  slideAlongSide,
  slidForApproach,
  tryZeroBendSlide,
} from '../../layout/edges/side-slides.js'
import {
  approachesSideways,
  cornerDetour,
  type DetourObstacle,
  squareEnds,
  strictInterior,
} from '../../layout/edges/straight-detour.js'
import { fc, fcTest, withDefaults } from '../fast-check.js'
import {
  coordinate,
  firstDifference,
  path,
  point,
  rect,
  rectsAgainst,
  size,
} from './edge-arbitraries.js'
import { built, requireWasm } from './glue.js'

/**
 * The router's leaf modules against their Rust port through the wasm
 * artifact (ADR-0054 step 5, QR-21 layer 2): side-slides.ts and
 * straight-detour.ts. Each side computes its own answer from the same draw,
 * compared exactly. routing-budget.ts is counters and subtraction, held by
 * the Rust unit tests alone.
 */

const SIDES = edgeSideSchema.options
const sideIndex = (side: EdgeSide) => SIDES.indexOf(side)
const side = fc.constantFrom(...SIDES)
const fraction = fc.oneof(fc.constantFrom(0, 0.5, 1, 0.1, 0.9), fc.double({ min: -0.2, max: 1.2 }))

/**
 * Two anchored ends the way the router sees them: each on its own box's
 * side. Two shapes are drawn on purpose, because free boxes almost never
 * make them: a FACING pair (the target box beyond the departure side, its
 * opposite side toward it), which is the only input the zero-bend slide
 * answers for, and an arrival a few pixels short of the departure along
 * its own normal, the only input the approach slide moves.
 */
/**
 * Boxes big enough that both anchors can sit inside the shared lane at
 * different coordinates, which is what decides which one the zero-bend
 * slide keeps.
 */
function facingPair(fromRect: Rect, fromSide: EdgeSide, f: number, short: number, along: number) {
  const n = outwardNormal(fromSide)
  const box = { x: fromRect.x, y: fromRect.y, w: 120, h: 120 }
  const toRect = {
    x: box.x + n.x * 160 + (n.x === 0 ? along % 20 : 0),
    y: box.y + n.y * 160 + (n.y === 0 ? along % 20 : 0),
    w: 120,
    h: 120,
  }
  const toSide = OPPOSITE[fromSide]
  const at = (k: number) => 0.2 + (Math.abs(k) % 60) / 100
  return {
    start: sidePointAt(box, fromSide, Number.isFinite(along) ? at(along) : f),
    end: sidePointAt(toRect, toSide, at(short * 7)),
    fromSide,
    toSide,
    fromRect: box,
    toRect,
  }
}

const endsDrawn = (kinds: fc.Arbitrary<string>) =>
  fc
    .tuple(
      rect,
      rect,
      side,
      side,
      fraction,
      fraction,
      fc.option(point, { freq: 4 }),
      kinds,
      // Inside the minimum approach, and both its bounds exactly.
      fc.oneof(fc.integer({ min: 1, max: 19 }), fc.constantFrom(0, 20)),
      coordinate,
    )
    .map(([fromRect, drawnTo, fromSide, drawnToSide, f, g, free, kind, short, along]) => {
      const start = sidePointAt(fromRect, fromSide, f)
      if (kind === 'facing') return facingPair(fromRect, fromSide, f, short, along)
      if (kind === 'short-approach') {
        // A perpendicular arrival `short` px back along its normal.
        const toSide = PERPENDICULAR[fromSide]
        const n = outwardNormal(toSide)
        const end = {
          x: start.x - n.x * short + n.y * along,
          y: start.y - n.y * short + n.x * along,
        }
        return { start, end, fromSide, toSide, fromRect, toRect: drawnTo }
      }
      const end = free ?? sidePointAt(drawnTo, drawnToSide, g)
      return { start, end, fromSide, toSide: drawnToSide, fromRect, toRect: drawnTo }
    })
const ends = endsDrawn(fc.constantFrom('anchored', 'anchored', 'facing', 'short-approach'))
/** The zero-bend slide answers for a facing pair alone, so it is drawn more of them. */
const zeroBendEnds = endsDrawn(fc.constantFrom('anchored', 'facing', 'facing', 'facing'))
const OPPOSITE = { top: 'bottom', bottom: 'top', left: 'right', right: 'left' } as const
const PERPENDICULAR = { top: 'left', bottom: 'right', left: 'top', right: 'bottom' } as const
type Ends = typeof ends extends fc.Arbitrary<infer T> ? T : never

const headOf = (e: Ends) => [
  e.start.x,
  e.start.y,
  e.end.x,
  e.end.y,
  sideIndex(e.fromSide),
  sideIndex(e.toSide),
  e.fromRect.x,
  e.fromRect.y,
  e.fromRect.w,
  e.fromRect.h,
  e.toRect.x,
  e.toRect.y,
  e.toRect.w,
  e.toRect.h,
]

const slideCase = fc.tuple(
  ends,
  fc.integer({ min: 0, max: 40 }).map((k) => k * 1.5),
  fc.oneof(
    point,
    coordinate.map((t) => ({ x: t, y: t })),
  ),
)

const routeOut = (route: readonly Point[] | undefined) =>
  route === undefined ? [-1] : [route.length, ...route.flatMap((p) => [p.x, p.y])]
const rectList = (rs: readonly Rect[]) => [rs.length, ...rs.flatMap((r) => [r.x, r.y, r.w, r.h])]

const reach = {
  slid: 0,
  approachMoved: 0,
  deepened: 0,
  sideways: 0,
  zeroBend: 0,
  zeroBendBlocked: 0,
  zeroBendKeptStart: 0,
  straight: 0,
  around: 0,
  noDetour: 0,
  exitSquared: 0,
  entrySquared: 0,
}

const detourCase = fc
  .tuple(point, point, fc.constantFrom(0, 8, 16))
  .chain(([start, end, clearance]) =>
    fc.tuple(
      fc.constant(start),
      fc.constant(end),
      fc.constant(clearance),
      fc.tuple(rectsAgainst([start, end]), size, size).chain(([drawn, w, h]) => {
        // One body across the leg's midpoint, so most draws must go around.
        const wall = {
          x: (start.x + end.x) / 2 - w / 2,
          y: (start.y + end.y) / 2 - h / 2,
          w,
          h,
        }
        const bodies = [wall, ...drawn]
        return fc.tuple(...bodies.map(() => fc.boolean())).map((escapable) =>
          bodies.map(
            (body, i): DetourObstacle => ({
              block: {
                x: body.x - clearance / 2,
                y: body.y - clearance / 2,
                w: body.w + clearance,
                h: body.h + clearance,
              },
              body,
              escapable: escapable[i] as boolean,
            }),
          ),
        )
      }),
    ),
  )

/**
 * A leg that starts in an escapable box's margin band ON its body's border
 * and runs along that border: the open interior it escapes by has zero
 * extent across the leg, which only an exactly collinear leg can test.
 */
const alongABorder = fc
  .tuple(rect, fc.constantFrom(8, 16))
  .map(([body, clearance]): [Point, Point, number, DetourObstacle[]] => [
    { x: body.x + body.w / 2, y: body.y },
    { x: body.x + body.w * 3 + 10, y: body.y },
    clearance,
    [
      {
        block: {
          x: body.x - clearance / 2,
          y: body.y - clearance / 2,
          w: body.w + clearance,
          h: body.h + clearance,
        },
        body,
        escapable: true,
      },
    ],
  ])

/**
 * A leg across a field of thin, tall walls, staggered so each round of the
 * corner search meets more of them: the only draw that reaches the search's
 * two bail-outs, more than 24 blockers and a seventh round. Free and
 * anchored draws hold at most six boxes, so they cannot. Neither exit is
 * visible from outside; the mutants of `MAX_BLOCKERS` and `MAX_ROUNDS`
 * failing this property is what shows the draw reaches them.
 */
const wallField = fc
  .tuple(
    fc.integer({ min: 40, max: 80 }),
    fc.array(fc.integer({ min: -60, max: 60 }), { minLength: 80, maxLength: 80 }),
    fc.array(fc.integer({ min: 40, max: 240 }), { minLength: 80, maxLength: 80 }),
    fc.constantFrom(8, 16),
  )
  .map(([count, offsets, heights, clearance]): [Point, Point, number, DetourObstacle[]] => {
    const walls = Array.from({ length: count }, (_, k): DetourObstacle => {
      const h = heights[k] as number
      const body = { x: 30 + k * 18, y: (offsets[k] as number) - h / 2, w: 4, h }
      return {
        block: {
          x: body.x - clearance / 2,
          y: body.y - clearance / 2,
          w: body.w + clearance,
          h: body.h + clearance,
        },
        body,
        escapable: k % 5 === 0,
      }
    })
    return [{ x: 0, y: 0 }, { x: 30 + count * 18 + 20, y: 0 }, clearance, walls]
  })

/**
 * A leg through a lattice of small boxes: every leg out of a corner meets
 * several at once, so the blocker count passes the cap within the first
 * rounds, where the wall field runs out of rounds first.
 */
function lattice(cols: number, rows: number, pitch: number, clearance: number, dy: number) {
  const boxes: DetourObstacle[] = []
  for (let c = 0; c < cols; c++) {
    for (let r = 0; r < rows; r++) {
      const body = {
        x: 20 + c * pitch,
        y: -(rows * pitch) / 2 + r * pitch,
        w: pitch / 2,
        h: pitch / 2,
      }
      boxes.push({
        block: {
          x: body.x - clearance / 4,
          y: body.y - clearance / 4,
          w: body.w + clearance / 2,
          h: body.h + clearance / 2,
        },
        body,
        escapable: false,
      })
    }
  }
  return [{ x: 0, y: dy }, { x: 40 + cols * pitch, y: -dy }, clearance, boxes] as [
    Point,
    Point,
    number,
    DetourObstacle[],
  ]
}

const boxLattice = fc
  .tuple(
    fc.integer({ min: 6, max: 10 }),
    fc.integer({ min: 6, max: 10 }),
    fc.integer({ min: 18, max: 30 }),
    fc.constantFrom(8, 16),
  )
  .map(([cols, rows, pitch, clearance]) => lattice(cols, rows, pitch, clearance, 3))

describe.runIf(built)(
  'side-slides.ts, straight-detour.ts and their Rust port answer the same',
  () => {
    fcTest.prop([fc.array(slideCase, { minLength: 1, maxLength: 24 })], withDefaults())(
      'side slides',
      (cases) => {
        const ts = cases.flatMap(([e, fromDepth, target]) => {
          const toNormal = outwardNormal(e.toSide)
          const slid = slideAlongSide(e.start, e.fromRect, e.fromSide, target)
          const approach = slidForApproach(
            e.start,
            e.end,
            e.fromSide,
            e.toSide,
            e.fromRect,
            toNormal,
          )
          const depth = deepenedCorridor(e.start, e.end, e.fromSide, e.toSide, fromDepth, toNormal)
          const sideways = approachesSideways(e.start, e.end, e.fromSide)
          const inner = strictInterior(e.fromRect)
          if (slid !== undefined) reach.slid += 1
          if (approach !== e.start) reach.approachMoved += 1
          if (depth !== fromDepth) reach.deepened += 1
          if (sideways) reach.sideways += 1
          return [
            slid === undefined ? 0 : 1,
            slid?.x ?? Number.NaN,
            slid?.y ?? Number.NaN,
            approach.x,
            approach.y,
            depth,
            sideways ? 1 : 0,
            inner.x,
            inner.y,
            inner.w,
            inner.h,
          ]
        })
        const input = Float64Array.from(
          cases.flatMap(([e, fromDepth, target]) => {
            const n = outwardNormal(e.toSide)
            return [...headOf(e), n.x, n.y, fromDepth, target.x, target.y]
          }),
        )
        expect(firstDifference(ts, requireWasm().edge_side_slides(input))).toBeUndefined()
      },
    )

    fcTest.prop(
      [zeroBendEnds.chain((e) => fc.tuple(fc.constant(e), rectsAgainst([e.start, e.end])))],
      withDefaults(),
    )('zero-bend slide', ([e, inflated]) => {
      const route = tryZeroBendSlide(
        e.start,
        e.end,
        e.fromSide,
        e.toSide,
        e.fromRect,
        e.toRect,
        inflated,
      )
      if (route !== undefined) {
        reach.zeroBend += 1
        const tangent = (q: Point, s: EdgeSide) => (s === 'left' || s === 'right' ? q.y : q.x)
        const kept = tangent(route[0] as Point, e.fromSide)
        if (kept === tangent(e.start, e.fromSide) && kept !== tangent(e.end, e.toSide))
          reach.zeroBendKeptStart += 1
      } else if (tryZeroBendSlide(e.start, e.end, e.fromSide, e.toSide, e.fromRect, e.toRect, []))
        reach.zeroBendBlocked += 1
      const rust = requireWasm().edge_zero_bend_slide(
        Float64Array.from([...headOf(e), ...rectList(inflated)]),
      )
      expect(firstDifference(routeOut(route), rust)).toBeUndefined()
    })

    fcTest.prop(
      [
        fc.oneof(
          { weight: 3, arbitrary: detourCase },
          { weight: 1, arbitrary: alongABorder },
          { weight: 1, arbitrary: wallField },
          { weight: 2, arbitrary: boxLattice },
        ),
      ],
      withDefaults(),
    )('corner detour', ([start, end, clearance, obstacles]) => {
      const route = cornerDetour(start, end, obstacles, clearance)
      if (route === undefined) reach.noDetour += 1
      else if (route.length === 2) reach.straight += 1
      else reach.around += 1
      const input = Float64Array.from([
        start.x,
        start.y,
        end.x,
        end.y,
        clearance,
        obstacles.length,
        ...obstacles.flatMap((o) => [
          o.block.x,
          o.block.y,
          o.block.w,
          o.block.h,
          o.body.x,
          o.body.y,
          o.body.w,
          o.body.h,
          o.escapable ? 1 : 0,
        ]),
      ])
      expect(
        firstDifference(routeOut(route), requireWasm().edge_corner_detour(input)),
      ).toBeUndefined()
    })

    // The corner search's two bail-outs, each pinned by a lattice where it
    // changes the answer. Found by scanning lattices against the Rust build
    // with MAX_BLOCKERS lifted to 1000 (cap) and MAX_ROUNDS to 100 (rounds):
    // the draws reach these exits, but at the cap the best route so far is
    // usually the final one, so a mutant of either survives most runs.
    it.each([
      { exit: 'the blocker cap', at: lattice(6, 5, 14, 16, 7) },
      { exit: 'the last round', at: lattice(4, 6, 14, 8, 3) },
    ])('takes $exit where the TypeScript does', ({ at: [start, end, clearance, obstacles] }) => {
      const route = cornerDetour(start, end, obstacles, clearance)
      const input = Float64Array.from([
        start.x,
        start.y,
        end.x,
        end.y,
        clearance,
        obstacles.length,
        ...obstacles.flatMap((o) => [
          o.block.x,
          o.block.y,
          o.block.w,
          o.block.h,
          o.body.x,
          o.body.y,
          o.body.w,
          o.body.h,
          o.escapable ? 1 : 0,
        ]),
      ])
      expect(
        firstDifference(routeOut(route), requireWasm().edge_corner_detour(input)),
      ).toBeUndefined()
    })

    fcTest.prop(
      [
        path
          .filter((p) => p.length >= 2)
          .chain((p) => fc.tuple(fc.constant(p), point, point, side, side, rectsAgainst(p))),
      ],
      withDefaults(),
    )('square ends', ([p, exit, entry, fromSide, toSide, obstacles]) => {
      const clear = (a: Point, b: Point) => obstacles.every((r) => !segmentCrossesRect(a, b, r))
      const squared = squareEnds([...p], { exit, entry, fromSide, toSide, clear })
      if (squared[1] === exit) reach.exitSquared += 1
      if (squared[squared.length - 2] === entry) reach.entrySquared += 1
      const input = Float64Array.from([
        p.length,
        ...p.flatMap((q) => [q.x, q.y]),
        exit.x,
        exit.y,
        entry.x,
        entry.y,
        sideIndex(fromSide),
        sideIndex(toSide),
        ...rectList(obstacles),
      ])
      expect(
        firstDifference(routeOut(squared), requireWasm().edge_square_ends(input)),
      ).toBeUndefined()
    })

    afterAllFloor(['side slides', 'zero-bend slide', 'corner detour', 'square ends'], () => {
      // Each answer's branches are reached; the corner search's two
      // bail-outs by the wall field, which its mutants show (see
      // `wallField`). Floors at about half of what three runs measured.
      expect(reach.slid).toBeGreaterThan(55)
      expect(reach.approachMoved).toBeGreaterThan(11)
      expect(reach.deepened).toBeGreaterThan(11)
      expect(reach.sideways).toBeGreaterThan(190)
      expect(reach.zeroBend).toBeGreaterThan(30)
      expect(reach.zeroBendBlocked).toBeGreaterThan(25)
      expect(reach.zeroBendKeptStart).toBeGreaterThan(30)
      expect(reach.straight).toBeGreaterThan(35)
      expect(reach.around).toBeGreaterThan(17)
      expect(reach.noDetour).toBeGreaterThan(40)
      expect(reach.exitSquared).toBeGreaterThan(30)
      expect(reach.entrySquared).toBeGreaterThan(30)
    })
  },
)
