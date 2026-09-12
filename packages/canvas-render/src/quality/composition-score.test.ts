// Calibration of the composition score against KNOWN truths, the way
// `drawing-score.test.ts` calibrates the drawing score: a board with one
// planted compositional mistake reports it in the column that names it, and
// nowhere else. `composition-quality.test.ts` is the scoreboard that pins
// this over the real corpus; this file is what says it can be believed
// there — an instrument trusted before it is calibrated is how
// `worstStallMs` reported 0.3ms for a 200ms stall.
//
// ADR-0032 fixes what these columns may be read to mean: the composition a
// drawing hands its reader, never that it was understood.
import type { CanvasEdge, SpatialCanvas, SpatialNode } from '@kamiazya/whiteboard-model'
import type { Scene } from '@kamiazya/whiteboard-scene'
import { describe, expect, it } from 'vitest'
import { layoutSpatialCanvas } from '../layout/spatial-canvas.js'
import { constantRatioMeasureText } from '../measure.js'
import { createSpatialTheme } from '../theme/spatial-theme.js'
import { type CompositionScore, scoreComposition } from './composition-score.js'

const measure = constantRatioMeasureText
const appearance = createSpatialTheme({ mode: 'light' })
const layout = (canvas: SpatialCanvas): Scene =>
  layoutSpatialCanvas(canvas, { measure, appearance })
const score = (canvas: SpatialCanvas): CompositionScore => scoreComposition(canvas, layout(canvas))

const box = (id: string, x: number, y: number, width = 200, height = 80): SpatialNode => ({
  id,
  type: 'text',
  x,
  y,
  width,
  height,
  text: id,
})
const group = (id: string, x: number, y: number, width: number, height: number): SpatialNode => ({
  id,
  type: 'group',
  x,
  y,
  width,
  height,
  label: id,
})
const edge = (id: string, fromNode: string, toNode: string): CanvasEdge => ({
  id,
  from: { node: fromNode },
  to: { node: toNode },
})
const canvasOf = (
  nodes: readonly SpatialNode[],
  edges: readonly CanvasEdge[] = [],
): SpatialCanvas => ({ nodes, edges }) as SpatialCanvas

describe('composition: proximity', () => {
  // Two members of a frame, and an outsider. What the column reads is
  // whether the drawing's SPACING says the same thing its frame says.
  const framed = (outsiderX: number, memberGap: number) =>
    canvasOf([
      group('g', 0, 0, 240 + memberGap + 200, 200),
      box('a', 20, 60),
      box('b', 20 + 200 + memberGap, 60),
      box('outsider', outsiderX, 60),
    ])

  it('a group whose members sit further apart than the outsider is `apart`', () => {
    // Members 200px apart; an outsider 40px from the nearer of them. A
    // reader groups by proximity, so the picture says the outsider is one
    // of them and the frame says it is not.
    const s = score(framed(20 + 200 + 200 + 200 + 40, 200))
    expect(s.groups).toBe(1)
    expect(s.apart).toBe(1)
    expect(s.worstRatio).toBeGreaterThanOrEqual(1)
  })

  it('the same group reads well spaced once the outsider is further than the members are', () => {
    const s = score(framed(20 + 200 + 200 + 200 + 400, 200))
    expect(s.apart).toBe(0)
    expect(s.worstRatio).toBeLessThan(1)
  })

  it('counts a group whose inside gap EQUALS its outside gap as apart', () => {
    // The boundary, and a decision rather than an accident: equal spacing
    // gives a reader nothing to group by, so a tie is a contradiction of
    // the frame and not a pass. Members 200px apart inside; the outsider
    // exactly 200px from the nearer one.
    const s = score(
      canvasOf([
        group('g', 0, 0, 620, 200),
        box('a', 20, 60),
        box('b', 420, 60),
        box('out', 820, 60),
      ]),
    )
    expect(s.groups).toBe(1)
    expect(s.worstRatio).toBe(1)
    expect(s.apart).toBe(1)
  })

  it('declares a group per FRAME, and not per connected component', () => {
    // Measured out rather than argued out. With edge components in the set,
    // the hand-drawn SEQUENCE reference owed all three of its groups at a
    // worst ratio of 5.5 — a message box joined to a participant column at
    // the far side of the board, which is that diagram's grammar and not a
    // spacing mistake. A reference owing is what the calibration forbids.
    const chain = canvasOf(
      [box('a', 0, 0), box('b', 400, 0), box('c', 800, 0)],
      [edge('ab', 'a', 'b')],
    )
    expect(score(chain).groups).toBe(0)
    const framed = canvasOf([group('g', 0, 0, 640, 200), box('a', 32, 60), box('b', 400, 60)])
    expect(score(framed).groups).toBe(0)
    // ...and a frame holding SOME of the boxes: a frame around every box
    // leaves no outsider to measure a gap to, so it declares nothing either.
    const some = canvasOf([
      group('g', 0, 0, 640, 200),
      box('a', 32, 60),
      box('b', 400, 60),
      box('out', 1200, 60),
    ])
    expect(score(some).groups).toBe(1)
  })

  it('a board that declares no group at all is silent, which is the blind spot', () => {
    // Pinned rather than hidden: three boxes with no frame and no edge
    // declare nothing, so proximity has nothing to check and reads clean on
    // a board a reader might still find badly spaced. `drawing-score`'s
    // density is the nearest witness, as it is for a scattered board.
    const s = score(canvasOf([box('a', 0, 0), box('b', 40, 0), box('c', 900, 600)]))
    expect([s.groups, s.apart, s.worstRatio]).toEqual([0, 0, 0])
  })
})

describe('composition: alignment', () => {
  it('the same boxes read as more composed when they share lines', () => {
    const composed = canvasOf([box('a', 0, 0), box('b', 0, 200), box('c', 0, 400)])
    const scattered = canvasOf([box('a', 0, 0), box('b', 37, 200), box('c', 74, 400)])
    // Every box shares its left, centre and right with both others.
    expect(composed.nodes.length).toBe(3)
    expect(score(composed).offGuide).toBe(0)
    expect(score(composed).perGuide).toBeGreaterThan(score(scattered).perGuide)
    expect(score(scattered).offGuide).toBeGreaterThan(0)
  })

  it('`guides` alone is not a verdict: a scattered board has few lines too', () => {
    // The trap this pair exists to state. Both boards resolve to a small
    // number of shared lines, for opposite reasons — which is why the
    // monotone reading is `offGuide` and `perGuide`, never `guides`.
    const composed = canvasOf([box('a', 0, 0), box('b', 0, 200), box('c', 0, 400)])
    const scattered = canvasOf([box('a', 0, 0), box('b', 37, 211), box('c', 74, 433)])
    expect(score(scattered).guides).toBeLessThanOrEqual(score(composed).guides)
    expect(score(scattered).offGuide).toBeGreaterThan(score(composed).offGuide)
  })
})

describe('composition: repetition', () => {
  it('counts the distinct sizes and gaps a board spends', () => {
    const same = canvasOf([box('a', 0, 0), box('b', 400, 0), box('c', 800, 0)])
    expect([score(same).widths, score(same).heights]).toEqual([1, 1])
    const varied = canvasOf([
      box('a', 0, 0, 200, 80),
      box('b', 400, 0, 300, 120),
      box('c', 900, 0, 160, 40),
    ])
    expect([score(varied).widths, score(varied).heights]).toEqual([3, 3])
  })

  it('reads two sizes within a grid step as the same size', () => {
    const nearly = canvasOf([box('a', 0, 0, 200, 80), box('b', 400, 0, 203, 80)])
    expect(score(nearly).widths).toBe(1)
  })
})

describe('composition: contrast is reported, never owed', () => {
  it('reports the treatments a scene spends against the roles a graph has', () => {
    // ADR-0032 C4: this column may not be cited for or against a change.
    // It is pinned so a later reading has a number to look back at.
    const s = score(
      canvasOf(
        [box('a', 0, 0), box('b', 400, 0), box('c', 800, 0), box('d', 1200, 0)],
        [edge('ab', 'a', 'b'), edge('ac', 'a', 'c')],
      ),
    )
    // One theme, so one treatment; a hub, two sinks and a box alone.
    expect(s.treatments).toBe(1)
    expect(s.roles).toBe(3)
  })
})

describe('composition: a planted mistake moves the column that names it', () => {
  // The calibration that matters: each defect is planted on the SAME board,
  // and every other column has to stay where it was.
  const base = canvasOf([
    group('g', 0, 0, 640, 200),
    box('a', 32, 60),
    box('b', 400, 60),
    box('far', 1200, 60),
  ])

  it('spacing that contradicts the frame moves only proximity', () => {
    // The members keep a 168px gap; the outsider closes to 100px, so the
    // picture now puts it inside the group the frame excludes.
    const planted = canvasOf([
      group('g', 0, 0, 640, 200),
      box('a', 32, 60),
      box('b', 400, 60),
      box('far', 700, 60),
    ])
    const before = score(base)
    const after = score(planted)
    expect([before.apart, after.apart]).toEqual([0, 1])
    expect([after.widths, after.heights]).toEqual([before.widths, before.heights])
  })

  it('a box knocked off every shared line moves only alignment', () => {
    const planted = canvasOf([
      group('g', 0, 0, 640, 200),
      box('a', 32, 60),
      box('b', 400, 60),
      box('far', 1207, 67),
    ])
    const before = score(base)
    const after = score(planted)
    expect(after.offGuide).toBeGreaterThan(before.offGuide)
    expect([after.apart, after.widths, after.heights]).toEqual([
      before.apart,
      before.widths,
      before.heights,
    ])
  })

  it('one box given its own size moves only repetition', () => {
    const planted = canvasOf([
      group('g', 0, 0, 640, 200),
      box('a', 32, 60),
      box('b', 400, 60),
      box('far', 1200, 60, 320, 160),
    ])
    const before = score(base)
    const after = score(planted)
    expect([after.widths, after.heights]).toEqual([before.widths + 1, before.heights + 1])
    expect(after.apart).toBe(before.apart)
  })
})
