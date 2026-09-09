// The drawing scoreboard: what the two diagrams the tool-surface lane asks
// for score as a person would draw them, as a first attempt draws them, and
// after tidy — plus the fixture board every lane write starts from.
//
// A REFERENCE row carrying debt is a finding about the reference or the
// instrument, never accepted as the drawing's cost. A DRAFT row is what the
// instrument is for: each planted mistake shows up in exactly the column that
// names it, so a reader of a lane result knows what a non-zero there looks
// like on a board. The TIDIED rows say what `tidyNodes` buys and what it
// leaves — and the first reading found something it leaves that nothing had
// said: a frame and what it holds move as ONE unit, so an overlap INSIDE a
// frame is invisible to tidy. The architecture draft keeps its overlapping
// pair and all five near misses through a tidy that cleared its straddle
// and its hidden label.
//
// Pinned EXACTLY, like every scoreboard in this package: an improvement is
// as loud as a regression, and whoever moves a number says why in the diff.
import { describe, expect, it } from 'vitest'
import { layoutSpatialCanvas } from '../layout/spatial-canvas.js'
import { constantRatioMeasureText } from '../measure.js'
import { DRAWING_CORPUS, type DrawingCase } from '../test-utils/drawing-corpus.js'
import { createSpatialTheme } from '../theme/spatial-theme.js'
import { type DrawingScore, scoreDrawing } from './drawing-score.js'

// The measurer the lane and `wb_scene_render` fall back to, so a pin here
// and a `drawing` column there are the same number for the same board.
const measure = constantRatioMeasureText
const appearance = createSpatialTheme({ mode: 'light' })

const scores = new Map(
  DRAWING_CORPUS.map((c) => [
    c.name,
    scoreDrawing(c.canvas, layoutSpatialCanvas(c.canvas, { measure, appearance })),
  ]),
)

const DEBT_FREE = {
  nodeOverlaps: 0,
  overlapAreaPx: 0,
  straddles: 0,
  edgeThroughNode: 0,
  throughInkPx: 0,
  labelOverNode: 0,
  labelOverLabel: 0,
  labelCovered: 0,
  textOverflow: 0,
  crampedMembers: 0,
  nearMisses: 0,
}

describe('drawing quality across the corpus', () => {
  it('reports every board', () => {
    expect(Object.fromEntries(scores)).toEqual({
      'architecture/reference': {
        nodes: 11,
        edges: 8,
        ...DEBT_FREE,
        crossings: 0,
        bends: 6,
        edgeLengthPx: 3208,
        unevenGaps: 0,
        envelopePx: { w: 800, h: 860 },
        density: 0.19,
      },
      'architecture/drafted': {
        nodes: 11,
        edges: 8,
        // `auth` over `api` by 40px of a row.
        nodeOverlaps: 1,
        overlapAreaPx: 3200,
        // `search` across the Services frame's right edge.
        straddles: 1,
        edgeThroughNode: 0,
        throughInkPx: 0,
        labelOverNode: 0,
        labelOverLabel: 0,
        // "Storage", drawn inside the Services frame above it.
        labelCovered: 1,
        textOverflow: 0,
        // `cli` 8px from its frame's left; `mobile` 10px from its right.
        crampedMembers: 2,
        // `web` 2px below its row-mates and 6px right of `blob`; `cli` 8px
        // right of the two frames it is not in.
        nearMisses: 5,
        crossings: 0,
        bends: 2,
        edgeLengthPx: 2680,
        // The Clients row's gaps differ by 14px; the Services row has an
        // overlap where a gap should be.
        unevenGaps: 2,
        envelopePx: { w: 840, h: 750 },
        density: 0.2,
      },
      'architecture/tidied': {
        nodes: 11,
        edges: 8,
        // Tidy moves a frame with its members as one unit, so what is wrong
        // INSIDE a frame survives it: the overlap, the near misses, the
        // cramped members. It clears what is wrong BETWEEN units.
        nodeOverlaps: 1,
        overlapAreaPx: 3200,
        straddles: 0,
        edgeThroughNode: 0,
        throughInkPx: 0,
        labelOverNode: 0,
        labelOverLabel: 0,
        labelCovered: 0,
        textOverflow: 0,
        crampedMembers: 2,
        nearMisses: 5,
        crossings: 0,
        bends: 3,
        edgeLengthPx: 2855,
        unevenGaps: 1,
        envelopePx: { w: 840, h: 868 },
        density: 0.18,
      },
      'sequence/reference': {
        nodes: 7,
        edges: 4,
        ...DEBT_FREE,
        crossings: 0,
        bends: 1,
        edgeLengthPx: 1270,
        unevenGaps: 0,
        envelopePx: { w: 1000, h: 580 },
        density: 0.17,
      },
      'sequence/drafted': {
        nodes: 7,
        edges: 4,
        // The first message drawn over the Browser head.
        nodeOverlaps: 1,
        overlapAreaPx: 2000,
        straddles: 0,
        // The last message's route to Browser runs up through the first.
        edgeThroughNode: 1,
        throughInkPx: 62,
        labelOverNode: 0,
        labelOverLabel: 0,
        labelCovered: 0,
        textOverflow: 0,
        crampedMembers: 0,
        // Daemon's head 6px below the others; SQLite's 10px right of `m2`.
        nearMisses: 2,
        crossings: 0,
        bends: 0,
        edgeLengthPx: 937,
        unevenGaps: 1,
        envelopePx: { w: 1010, h: 520 },
        density: 0.18,
      },
      'sequence/tidied': {
        nodes: 7,
        edges: 4,
        // No frames, so every unit is a box and tidy reaches all of it.
        ...DEBT_FREE,
        crossings: 0,
        bends: 0,
        edgeLengthPx: 1006,
        unevenGaps: 0,
        envelopePx: { w: 1008, h: 524 },
        density: 0.18,
      },
      'fixture/architecture': {
        nodes: 7,
        edges: 3,
        ...DEBT_FREE,
        crossings: 0,
        bends: 0,
        edgeLengthPx: 620,
        unevenGaps: 0,
        envelopePx: { w: 1000, h: 900 },
        density: 0.11,
      },
      'lane/architecture': {
        nodes: 11,
        edges: 8,
        // The same numbers the lane's `drawing` column printed for this
        // board, which is the point of scoring both with one measurer.
        ...DEBT_FREE,
        // API gateway's two edges to the boxes beside it, pinned to leave
        // from its bottom and arrive from their top, tunnel back through
        // API gateway on the way round.
        edgeThroughNode: 2,
        throughInkPx: 174,
        // One of them across the Web app edge.
        crossings: 1,
        bends: 6,
        edgeLengthPx: 3266,
        // The layers sit 300 and 280 apart.
        unevenGaps: 2,
        envelopePx: { w: 820, h: 800 },
        density: 0.27,
      },
    })
  })

  it('the lane board owes its debt to the sides the model pinned, not to its boxes', () => {
    const lane = scores.get('lane/architecture') as DrawingScore
    const unpinned = DRAWING_CORPUS.find((c) => c.name === 'lane/architecture') as DrawingCase
    const withoutSides = {
      ...unpinned.canvas,
      edges: unpinned.canvas.edges.map(({ fromSide: _from, toSide: _to, ...edge }) => edge),
    }
    const free = scoreDrawing(
      withoutSides,
      layoutSpatialCanvas(withoutSides, { measure, appearance }),
    )
    expect([lane.edgeThroughNode, lane.crossings]).toEqual([2, 1])
    // Debt-free without them; what the router then draws on its own for
    // eight edges converging on one box is price, and pinned as such.
    expect(free).toMatchObject(DEBT_FREE)
    expect([free.crossings, free.bends]).toEqual([2, 7])
  })

  it('every reference carries no debt', () => {
    for (const name of ['architecture/reference', 'sequence/reference', 'fixture/architecture']) {
      expect(scores.get(name), name).toMatchObject(DEBT_FREE)
    }
  })

  it('tidy clears what is wrong between units and leaves what is wrong inside a frame', () => {
    const drafted = scores.get('architecture/drafted') as DrawingScore
    const tidied = scores.get('architecture/tidied') as DrawingScore
    expect([drafted.straddles, tidied.straddles]).toEqual([1, 0])
    expect([drafted.labelCovered, tidied.labelCovered]).toEqual([1, 0])
    expect(tidied.nodeOverlaps).toBe(drafted.nodeOverlaps)
    expect(tidied.nearMisses).toBe(drafted.nearMisses)
  })
})
