// The PER-NODE half of the layout budget. `spatial-edges.bench.ts` measures
// the edge search, which grows with the square of the canvas and drowns
// everything else; this file deliberately keeps the edge set tiny so what is
// left is what layout spends per node — including the facet reads that decide
// a node's silhouette, its badge and its text placement.
//
// Run with `pnpm bench`.
//
// **The pair is the measurement, not either row.** `plain` carries no facets
// and `styled` carries three on every node, so the DIFFERENCE between them is
// the facet path's whole cost. A change that adds indirection to that path
// widens the gap even when both rows drift together with machine noise — and
// machine noise is the reason a single row proves nothing here.
//
// Numbers are machine-specific and this session measured drift of 2-3x
// between runs when other work was in flight. Compare a before/after on the
// SAME machine, in INTERLEAVED runs, in one sitting — never a committed
// figure against a fresh one.
//
// What the pair reported when it was written, on an idle machine (load 0.09):
//
//   120 plain   978.94 hz  ±2.37%      480 plain   361.32 hz  ±2.95%
//   120 styled  231.73 hz  ±9.89%      480 styled   75.81 hz  ±9.14%
//                4.22x                              4.77x
//
// So the facet path — the reads plus the extra scene nodes they produce —
// costs roughly four times everything else layout does per node. That is the
// headroom this bench has: the styled rows carry ±10% run to run, so a change
// worth arguing about has to move the RATIO by more than that. Anything
// smaller than ~10% is noise here, not a result.
import type { CanvasEdge, SpatialCanvas, SpatialNode } from '@kamiazya/whiteboard-model'
import { bench, describe } from 'vitest'
import { createFakeMeasure } from '../test-utils/fake-measure.js'
import { layoutSpatialCanvas, type SpatialLayoutOptions } from './spatial-canvas.js'

const OPTIONS: SpatialLayoutOptions = {
  measure: createFakeMeasure(),
  // A fixed body rather than a real parse: markdown parsing is
  // `mdast-blocks.bench.ts`'s subject, and leaving it in here would be the
  // same drowning problem the edge search causes.
  parseBody: () => ({ type: 'root', children: [{ type: 'paragraph', children: [] }] }),
  appearance: { resolveNode: () => ({}), resolveEdge: () => ({}), resolveLabel: () => ({}) },
}

// Cycled rather than random: a bench whose input changes between runs is
// measuring two things at once.
const SHAPES = ['ellipse', 'diamond', 'hexagon', 'parallelogram', 'cylinder'] as const
const ALIGNS = ['top', 'middle'] as const

function canvasOf(nodeCount: number, styled: boolean): SpatialCanvas {
  const nodes: SpatialNode[] = Array.from({ length: nodeCount }, (_, i) => {
    const node: SpatialNode = {
      id: `n${i}`,
      type: 'text',
      x: (i % 12) * 260,
      y: Math.floor(i / 12) * 180,
      // Comfortably larger than the badge plus its margin, so the badge is
      // actually composed — a node too small to fit one returns early, and
      // then this bench would be measuring the early return.
      width: 200,
      height: 120,
      text: `n${i}`,
    }
    if (!styled) return node
    return {
      ...node,
      'x-whiteboard': {
        facets: {
          'visual.shape/v0': { kind: SHAPES[i % SHAPES.length] },
          'visual.symbol/v0':
            i % 2 === 0 ? { kind: 'icon', name: 'star' } : { kind: 'emoji', char: '⭐' },
          'visual.text/v0': { placement: ALIGNS[i % ALIGNS.length] },
        },
      },
    }
  })
  // Two edges only: present so the edge pass is not skipped outright, few
  // enough that its cost stays negligible against the node pass.
  const edges: CanvasEdge[] = [
    { id: 'e0', fromNode: 'n0', toNode: `n${Math.min(1, nodeCount - 1)}` },
    { id: 'e1', fromNode: `n${nodeCount - 1}`, toNode: 'n0' },
  ]
  return { nodes, edges }
}

/**
 * Labels that DO NOT FIT, which the cases above never produce: their labels
 * are `n0`..`n479`, and at the fake measurer's 0.6 factor and a 16px label
 * font that is ~29px against a 200px box, so `fitToWidth`'s cut loop never
 * runs and this bench is blind to how a label is cut.
 *
 * Mixed script on purpose. The cut walks the label unit by unit, measuring
 * each prefix, so its cost tracks the number of UNITS — and what counts as a
 * unit is exactly what a change to the cut rule moves. ASCII, Japanese and
 * grapheme clusters (a ZWJ family, a flag, a skin-tone modifier) each answer
 * that differently.
 */
const OVERFLOWING_LABEL = 'Design review of the Q3 migration 設計レビュー 👨‍👩‍👧‍👦 🇯🇵 👍🏽 done'

function labelledCanvasOf(nodeCount: number, label = OVERFLOWING_LABEL): SpatialCanvas {
  const nodes: SpatialNode[] = Array.from({ length: nodeCount }, (_, i) => ({
    id: `g${i}`,
    type: 'group',
    x: (i % 12) * 260,
    y: Math.floor(i / 12) * 180,
    width: 200,
    height: 120,
    label: `${label} ${i}`,
  }))
  const edges: CanvasEdge[] = [
    { id: 'e0', fromNode: 'g0', toNode: `g${Math.min(1, nodeCount - 1)}` },
  ]
  return { nodes, edges }
}

const plain120 = canvasOf(120, false)
const styled120 = canvasOf(120, true)
const plain480 = canvasOf(480, false)
const styled480 = canvasOf(480, true)
const labelled480 = labelledCanvasOf(480)
const asciiLabelled480 = labelledCanvasOf(
  480,
  'Design review of the Q3 migration schedule and rollout plan done',
)

describe('layoutSpatialCanvas, per-node path', () => {
  bench('120 nodes, plain', () => {
    layoutSpatialCanvas(plain120, OPTIONS)
  })

  bench('120 nodes, three facets each', () => {
    layoutSpatialCanvas(styled120, OPTIONS)
  })

  bench('480 nodes, plain', () => {
    layoutSpatialCanvas(plain480, OPTIONS)
  })

  bench('480 nodes, three facets each', () => {
    layoutSpatialCanvas(styled480, OPTIONS)
  })

  // The one case that enters `fitToWidth`'s cut loop. Its own number is the
  // point: the four above cannot move when the cut rule changes, so a
  // before/after on them alone reads as "free".
  bench('480 nodes, labels that overflow', () => {
    layoutSpatialCanvas(labelled480, OPTIONS)
  })

  // The same case with an ASCII-only label. Paired with the row above because
  // the cost of a cut rule can depend on the SCRIPT, and one row cannot show
  // that.
  bench('480 nodes, ascii labels that overflow', () => {
    layoutSpatialCanvas(asciiLabelled480, OPTIONS)
  })
})
