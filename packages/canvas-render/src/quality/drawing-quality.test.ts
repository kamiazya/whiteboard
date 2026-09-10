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
  tightGaps: 0,
  edgeThroughFrame: 0,
  edgeOverlaps: 0,
  sharedInkPx: 0,
}
const DEBT_COLUMNS = Object.keys(DEBT_FREE) as (keyof typeof DEBT_FREE)[]

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
        // Even the reference: the router draws the two same-row edges inside
        // the Services frame as loops — down from the box's bottom, along,
        // back up — one reversal on api->auth and two on api->search, which
        // also climbs over Auth. Nothing else on the board turns back. A
        // finding about the router's side choice for a neighbour on the same
        // row, which this column exists to expose; a fix is judged here.
        reversals: 3,
        flow: 'down',
        againstFlow: 0,
        crossingsPerEdge: 0,
        bendsPerEdge: 0.75,
        overlapsPerPair: 0,
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
        tightGaps: 0,
        edgeThroughFrame: 0,
        edgeOverlaps: 0,
        sharedInkPx: 0,
        crossings: 0,
        bends: 2,
        edgeLengthPx: 2680,
        // The Clients row's gaps differ by 14px; the Services row has an
        // overlap where a gap should be.
        unevenGaps: 2,
        envelopePx: { w: 840, h: 750 },
        // Only api->auth loops; api->search is drawn straight, because Auth
        // moved onto API gateway and the line starts inside it.
        reversals: 1,
        flow: 'down',
        againstFlow: 0,
        crossingsPerEdge: 0,
        bendsPerEdge: 0.25,
        overlapsPerPair: 0.04,
        density: 0.2,
      },
      'architecture/tidied': {
        nodes: 11,
        edges: 8,
        // Tidy clears what is wrong between units and, since it tidies
        // inside a frame, what is wrong among a frame's members too: the
        // overlap and the cramped members go. What it leaves is the two
        // near misses between members of DIFFERENT frames (`cli` moved in
        // to its frame's 32px margin; `api` and `sqlite` sit at 40 in
        // theirs), which no band sees — bands run among a frame's members
        // and among the frames, never across them.
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
        nearMisses: 2,
        tightGaps: 0,
        edgeThroughFrame: 0,
        edgeOverlaps: 0,
        sharedInkPx: 0,
        // One crossing where the frames' members, now separated, put
        // `search` under `auth` in the Services frame; the router pays it
        // rather than the reversal and two bends it drew before.
        crossings: 1,
        bends: 1,
        edgeLengthPx: 2708,
        unevenGaps: 2,
        envelopePx: { w: 840, h: 884 },
        reversals: 0,
        flow: 'down',
        againstFlow: 0,
        crossingsPerEdge: 0.13,
        bendsPerEdge: 0.13,
        overlapsPerPair: 0,
        density: 0.17,
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
        // Messages are boxes whose arrows point up to the participant heads,
        // three of the four along the column, so the board flows up.
        reversals: 0,
        flow: 'up',
        againstFlow: 0,
        crossingsPerEdge: 0,
        bendsPerEdge: 0.25,
        overlapsPerPair: 0,
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
        tightGaps: 0,
        edgeThroughFrame: 0,
        edgeOverlaps: 0,
        sharedInkPx: 0,
        crossings: 0,
        bends: 0,
        edgeLengthPx: 937,
        unevenGaps: 1,
        envelopePx: { w: 1010, h: 520 },
        // Two arrows head right and two up: a tie, which goes to `right` by
        // the fixed order, and the two upward arrows then read as against
        // it. The draft's first two messages sit far enough left of their
        // heads for that to be what the picture says.
        reversals: 0,
        flow: 'right',
        againstFlow: 2,
        crossingsPerEdge: 0,
        bendsPerEdge: 0,
        overlapsPerPair: 0.05,
        density: 0.18,
      },
      'sequence/tidied': {
        nodes: 7,
        edges: 4,
        // No frames, so every unit is a box and tidy reaches all of it.
        ...DEBT_FREE,
        crossings: 0,
        bends: 0,
        edgeLengthPx: 1010,
        unevenGaps: 0,
        envelopePx: { w: 1008, h: 524 },
        // Tidy moves boxes, not the direction their arrows travel.
        reversals: 0,
        flow: 'right',
        againstFlow: 2,
        crossingsPerEdge: 0,
        bendsPerEdge: 0,
        overlapsPerPair: 0,
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
        reversals: 0,
        flow: 'right',
        againstFlow: 0,
        crossingsPerEdge: 0,
        bendsPerEdge: 0,
        overlapsPerPair: 0,
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
        // The two loops under API gateway: each dips and comes back up, and
        // one also doubles back along the row.
        reversals: 4,
        flow: 'down',
        againstFlow: 0,
        crossingsPerEdge: 0.13,
        bendsPerEdge: 0.75,
        overlapsPerPair: 0,
        density: 0.27,
      },
      'lane/insert': {
        nodes: 8,
        edges: 4,
        ...DEBT_FREE,
        // Cache narrowed to 150 and centred in a 200px gap: 25px to the
        // daemon and 25px to SQLite. "libsql" is wider than its 25px edge,
        // so it slides above the row (`edgeLabelPlacement`) instead of
        // lying over both boxes, which is the 16px the envelope grew by.
        tightGaps: 2,
        labelOverNode: 0,
        crossings: 0,
        bends: 0,
        edgeLengthPx: 470,
        // The row's gaps: 200 between Browser and Daemon, 25 after it.
        unevenGaps: 1,
        envelopePx: { w: 1000, h: 916 },
        reversals: 0,
        flow: 'right',
        againstFlow: 0,
        crossingsPerEdge: 0,
        bendsPerEdge: 0,
        overlapsPerPair: 0,
        density: 0.12,
      },
      'lane/insert-roomy': {
        nodes: 8,
        edges: 4,
        // Debt-free: the neighbour moved instead of the box shrinking, and
        // "libsql", wider than its 50px edge, sits above the row (the 16px
        // of envelope) rather than over both boxes.
        ...DEBT_FREE,
        crossings: 0,
        bends: 0,
        edgeLengthPx: 520,
        // 200 between Browser and Daemon, 50 after it, twice.
        unevenGaps: 1,
        envelopePx: { w: 1100, h: 916 },
        reversals: 0,
        flow: 'right',
        againstFlow: 0,
        crossingsPerEdge: 0,
        bendsPerEdge: 0,
        overlapsPerPair: 0,
        density: 0.11,
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

  it('tidy clears what is wrong between units and inside a frame alike', () => {
    const drafted = scores.get('architecture/drafted') as DrawingScore
    const tidied = scores.get('architecture/tidied') as DrawingScore
    expect([drafted.straddles, tidied.straddles]).toEqual([1, 0])
    expect([drafted.labelCovered, tidied.labelCovered]).toEqual([1, 0])
    // Inside the Services frame: `api` over `auth`, and two members within
    // the padding of their frame. Both used to survive tidy.
    expect([drafted.nodeOverlaps, tidied.nodeOverlaps]).toEqual([1, 0])
    expect([drafted.crampedMembers, tidied.crampedMembers]).toEqual([2, 0])
    // Members of different frames are aligned by nobody; that pair stays.
    expect([drafted.nearMisses, tidied.nearMisses]).toEqual([5, 2])
  })
})

// What makes the instrument believable beyond its calibration: the pairs
// a person would order with confidence, ordered the same way by every debt
// column. A metric set can be satisfied by a drawing nobody would accept
// ("Same Quality Metrics, Different Graph Drawings", 2025 — the same
// readings for a grid and a dinosaur), so the last case pins the blind
// spot this set is known to have rather than pretending it has none.
describe('drawing quality: the instrument orders what a reader would', () => {
  const debtOf = (name: string) => {
    const s = scores.get(name) as DrawingScore
    return DEBT_COLUMNS.map((c) => [c, s[c]] as const)
  }

  it.each([
    'architecture',
    'sequence',
  ])('the %s reference owes no more than its draft on any column, and less in all', (diagram) => {
    const reference = debtOf(`${diagram}/reference`)
    const drafted = debtOf(`${diagram}/drafted`)
    for (const [i, [column, value]] of reference.entries()) {
      expect(value, column).toBeLessThanOrEqual(drafted[i]?.[1] as number)
    }
    const total = (rows: readonly (readonly [string, number])[]) =>
      rows.reduce((sum, [, v]) => sum + v, 0)
    expect(total(reference)).toBeLessThan(total(drafted))
  })

  it.each(['architecture', 'sequence'])('tidy never adds debt to the %s draft', (diagram) => {
    const drafted = debtOf(`${diagram}/drafted`)
    const tidied = debtOf(`${diagram}/tidied`)
    for (const [i, [column, value]] of tidied.entries()) {
      expect(value, column).toBeLessThanOrEqual(drafted[i]?.[1] as number)
    }
  })

  it('a board of boxes scattered far apart reads debt-free: density is its only witness', () => {
    // No column names "too far apart" — every debt is a thing touching a
    // thing it should not. A reader would still call this board unusable,
    // and the number that says so is the price column `density`, which has
    // no target. Pinned so the gap is a known one.
    const scattered = {
      nodes: [0, 1, 2, 3].map((i) => ({
        id: `b${i}`,
        type: 'text' as const,
        x: i * 3000,
        y: (i % 2) * 2500,
        width: 200,
        height: 80,
        text: `box ${i}`,
      })),
      edges: [],
    }
    const s = scoreDrawing(scattered, layoutSpatialCanvas(scattered, { measure, appearance }))
    expect(s).toMatchObject(DEBT_FREE)
    expect(s.density).toBeLessThan(0.01)
  })
})
