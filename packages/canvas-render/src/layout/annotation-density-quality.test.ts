// The annotation layer's density scoreboard (ADR-0029 decision 9).
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
import {
  ANNOTATION_DENSITY_CORPUS,
  type AnnotationDensityCase,
} from '../test-utils/annotation-density-corpus.js'
import {
  type CommentDensityScore,
  type ProposalDensityScore,
  scoreCommentDensity,
  scoreProposalDensity,
} from '../test-utils/annotation-density-metrics.js'
import { createFakeMeasure } from '../test-utils/fake-measure.js'
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

function sceneOf(entry: AnnotationDensityCase) {
  return layoutSpatialCanvas(entry.canvas, {
    measure,
    appearance,
    parseBody: (text) => ({
      type: 'root',
      children: [{ type: 'paragraph', children: [{ type: 'text', value: text }] }],
    }),
    proposals: entry.proposals,
    comments: entry.comments,
  })
}

const boxesOf = (entry: AnnotationDensityCase): BoundingBox[] =>
  entry.canvas.nodes.map((node) => ({ x: node.x, y: node.y, w: node.width, h: node.height }))

function score(entry: AnnotationDensityCase): ProposalDensityScore {
  return scoreProposalDensity(sceneOf(entry), boxesOf(entry))
}

function commentScore(entry: AnnotationDensityCase): CommentDensityScore {
  return scoreCommentDensity(sceneOf(entry), boxesOf(entry))
}

const byName = new Map(ANNOTATION_DENSITY_CORPUS.map((entry) => [entry.name, entry]))
const entryOf = (name: string): AnnotationDensityCase => {
  const entry = byName.get(name)
  if (entry === undefined) throw new Error(`no corpus case named ${name}`)
  return entry
}
const scoreOf = (name: string): ProposalDensityScore => score(entryOf(name))
const commentScoreOf = (name: string): CommentDensityScore => commentScore(entryOf(name))

describe('the proposal layer under density', () => {
  // A count beside the scoreboard, so a corpus that silently stopped
  // producing bubbles cannot report itself as a clean board.
  it('draws one bubble per open annotation in every corpus case', () => {
    for (const entry of ANNOTATION_DENSITY_CORPUS) {
      expect(score(entry).bubbles, `${entry.name} proposals`).toBe(entry.proposals.length)
      expect(commentScore(entry).bubbles, `${entry.name} comments`).toBe(entry.comments.length)
    }
  })

  // The one debt that is already zero, stated as a rule rather than as a
  // number: a bubble may be pushed anywhere except over the change it is
  // about. Nothing else on this board is worth covering it for.
  it('never covers the change its own proposal is about', () => {
    for (const entry of ANNOTATION_DENSITY_CORPUS) {
      expect(score(entry).overOwnOutline, entry.name).toBe(0)
    }
  })

  it('scores the spread board — the control', () => {
    expect(scoreOf('spread pitch 220x160, 40 proposals')).toEqual({
      bubbles: 40,
      cleanBubbles: 17,
      overOwnOutline: 0,
      overOtherOutline: 22080,
      overNode: 30990,
      overBubble: 0,
      meanLeaderPx: 23,
      maxLeaderPx: 23,
    })
  })

  // One number here got WORSE when the bubble was narrowed, and it is left
  // in rather than smoothed over: `ten`'s `overOtherOutline` went 7977 ->
  // 10700. A smaller box finds a placement the larger one could not, and at
  // that one density the placement it finds sits over a neighbouring
  // proposal's outline. Every other case improved, so it was taken — but a
  // pinned number that only ever moves the good way is a number nobody is
  // reading.
  //
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
        cleanBubbles: 2,
        overOwnOutline: 0,
        overOtherOutline: 2578,
        overNode: 4300,
        overBubble: 360,
        meanLeaderPx: 23,
        maxLeaderPx: 23,
      },
      ten: {
        bubbles: 10,
        cleanBubbles: 4,
        overOwnOutline: 0,
        overOtherOutline: 10700,
        overNode: 18114,
        overBubble: 720,
        meanLeaderPx: 23,
        maxLeaderPx: 23,
      },
      twenty: {
        bubbles: 20,
        cleanBubbles: 5,
        overOwnOutline: 0,
        overOtherOutline: 57033,
        overNode: 69430,
        overBubble: 1800,
        meanLeaderPx: 23,
        maxLeaderPx: 23,
      },
      forty: {
        bubbles: 40,
        cleanBubbles: 8,
        overOwnOutline: 0,
        overOtherOutline: 148981,
        overNode: 165653,
        overBubble: 3601,
        meanLeaderPx: 23,
        maxLeaderPx: 23,
      },
    })
  })
  // The placer's other consumer, on the same boards. It is here so that a
  // change made for the proposal layer cannot quietly move the comment
  // layer: they share one search, and until this ran nothing measured it.
  it('scores the comment layer, which shares the placer', () => {
    expect({
      spread: commentScoreOf('spread pitch 220x160, 40 comments'),
      crowdedTen: commentScoreOf('crowded pitch 168x90, 10 comments'),
      crowdedForty: commentScoreOf('crowded pitch 168x90, 40 comments'),
    }).toEqual({
      // Uncrowded, the comment layer is already perfect — every bubble
      // clean. Whatever a placer change buys here, it must not spend THIS.
      spread: {
        bubbles: 40,
        cleanBubbles: 40,
        overPin: 0,
        overNode: 0,
        overBubble: 0,
        meanLeaderPx: 23,
        maxLeaderPx: 23,
      },
      crowdedTen: {
        bubbles: 10,
        cleanBubbles: 1,
        overPin: 0,
        overNode: 14443,
        overBubble: 11750,
        meanLeaderPx: 23,
        maxLeaderPx: 23,
      },
      // The same collapse the proposal layer shows, on the same board: one
      // clean bubble in forty. It was never measured before this case
      // existed, and it is the reason a placer change cannot be judged on
      // the proposal numbers alone.
      crowdedForty: {
        bubbles: 40,
        cleanBubbles: 1,
        overPin: 0,
        overNode: 218688,
        overBubble: 34867,
        meanLeaderPx: 23,
        maxLeaderPx: 23,
      },
    })
  })
})
