// The proposal layer's density scoreboard (ADR-0029 decision 9).
//
// Decision 9 says a pile of proposals collapses to a count, and says in the
// same breath that this is a direction rather than an answer for what a
// document with forty open proposals looks like. Nothing had ever drawn one.
// This is the instrument that makes the unanswered half a question with an
// answer, and it lands BEFORE any change to the placer so that what follows
// is judged by it rather than by argument.
//
// DEBT targets zero. PRICE has no target and exists so a change that buys
// less overlap with a longer leader cannot do it silently.
//
// The numbers are pinned EXACTLY, not as ceilings: an improvement has to be
// as loud as a regression, because the point is that someone says why it
// moved. This is not a golden to regenerate.
import { describe, expect, it } from 'vitest'
import type { BoundingBox } from '../scene-graph.js'
import { createFakeMeasure } from '../test-utils/fake-measure.js'
import {
  PROPOSAL_DENSITY_CORPUS,
  type ProposalDensityCase,
} from '../test-utils/proposal-density-corpus.js'
import {
  type ProposalDensityScore,
  scoreProposalDensity,
} from '../test-utils/proposal-density-metrics.js'
import type { SpatialAppearanceResolver } from './nodes/spatial-appearance.js'
import { layoutSpatialCanvas } from './spatial-canvas.js'

const measure = createFakeMeasure()

const appearance: SpatialAppearanceResolver = {
  resolveNode: () => ({ radius: 4 }),
  resolveEdge: () => ({ stroke: '#606060', strokeWidth: 1.5 }),
  resolveLabel: () => ({ fill: '#303030', fontFamily: 'sans-serif' }),
  resolveProposal: () => ({
    outline: { fill: 'none', stroke: '#4f46e5', strokeWidth: 2, strokeDasharray: '6 4' },
    bubble: { fill: '#ffffff', stroke: '#4f46e5' },
    leader: { stroke: '#4f46e5', strokeWidth: 1, strokeDasharray: '4 3' },
  }),
}

function score(entry: ProposalDensityCase): ProposalDensityScore {
  const scene = layoutSpatialCanvas(entry.canvas, {
    measure,
    appearance,
    parseBody: (text) => ({
      type: 'root',
      children: [{ type: 'paragraph', children: [{ type: 'text', value: text }] }],
    }),
    proposals: entry.proposals,
  })
  const nodeBoxes: BoundingBox[] = entry.canvas.nodes.map((node) => ({
    x: node.x,
    y: node.y,
    w: node.width,
    h: node.height,
  }))
  return scoreProposalDensity(scene, nodeBoxes)
}

const byName = new Map(PROPOSAL_DENSITY_CORPUS.map((entry) => [entry.name, entry]))
const scoreOf = (name: string): ProposalDensityScore => {
  const entry = byName.get(name)
  if (entry === undefined) throw new Error(`no corpus case named ${name}`)
  return score(entry)
}

describe('the proposal layer under density', () => {
  // A count beside the scoreboard, so a corpus that silently stopped
  // producing bubbles cannot report itself as a clean board.
  it('draws one bubble per open proposal in every corpus case', () => {
    for (const entry of PROPOSAL_DENSITY_CORPUS) {
      expect(score(entry).bubbles, entry.name).toBe(entry.proposals.length)
    }
  })

  // The one debt that is already zero, stated as a rule rather than as a
  // number: a bubble may be pushed anywhere except over the change it is
  // about. Nothing else on this board is worth covering it for.
  it('never covers the change its own proposal is about', () => {
    for (const entry of PROPOSAL_DENSITY_CORPUS) {
      expect(score(entry).overOwnOutline, entry.name).toBe(0)
    }
  })

  it('scores the spread board — the control', () => {
    expect(scoreOf('spread pitch 220x160, 40 proposals')).toEqual({
      bubbles: 40,
      cleanBubbles: 17,
      overOwnOutline: 0,
      overOtherOutline: 25600,
      overNode: 40832,
      overBubble: 4928,
      meanLeaderPx: 23,
      maxLeaderPx: 23,
    })
  })

  // Every leader is 23px in every case, and that is the finding rather than
  // a quirk of the fixture: today's four candidates all sit one 14px offset
  // from the anchor, so the placer has NO ability to trade distance for
  // clarity. It picks the least-covered of four equally near boxes, and when
  // all four are covered it takes the least bad one and stays put. A change
  // that buys clean bubbles will move this number, which is the point of
  // pinning it beside the debt.
  it('scores the crowded board as it fills', () => {
    expect({
      five: scoreOf('crowded pitch 168x90, 5 proposals'),
      ten: scoreOf('crowded pitch 168x90, 10 proposals'),
      twenty: scoreOf('crowded pitch 168x90, 20 proposals'),
      forty: scoreOf('crowded pitch 168x90, 40 proposals'),
    }).toEqual({
      five: {
        bubbles: 5,
        cleanBubbles: 0,
        overOwnOutline: 0,
        overOtherOutline: 2908,
        overNode: 5824,
        overBubble: 3778,
        meanLeaderPx: 23,
        maxLeaderPx: 23,
      },
      ten: {
        bubbles: 10,
        cleanBubbles: 1,
        overOwnOutline: 0,
        overOtherOutline: 7977,
        overNode: 22135,
        overBubble: 6390,
        meanLeaderPx: 23,
        maxLeaderPx: 23,
      },
      twenty: {
        bubbles: 20,
        cleanBubbles: 1,
        overOwnOutline: 0,
        overOtherOutline: 68527,
        overNode: 93574,
        overBubble: 15976,
        meanLeaderPx: 23,
        maxLeaderPx: 23,
      },
      forty: {
        bubbles: 40,
        cleanBubbles: 1,
        overOwnOutline: 0,
        overOtherOutline: 183920,
        overNode: 221694,
        overBubble: 33475,
        meanLeaderPx: 23,
        maxLeaderPx: 23,
      },
    })
  })
})
