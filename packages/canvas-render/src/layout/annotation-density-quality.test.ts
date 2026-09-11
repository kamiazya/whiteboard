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

import type { BoundingBox } from '@kamiazya/whiteboard-scene'
import { describe, expect, it } from 'vitest'
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
      cleanBubbles: 40,
      overOwnOutline: 0,
      overOtherOutline: 0,
      overNode: 0,
      overBubble: 0,
      meanLeaderPx: 38,
      maxLeaderPx: 50,
    })
  })

  // Numbers here move in BOTH directions and are left that way. Narrowing
  // the bubble made `ten`'s outline overlap worse (7977 -> 10700) before the
  // ring took it to zero; widening the candidate ring collapsed node and
  // outline overlap while making bubble-on-bubble WORSE at twenty and forty
  // (1800 -> 4856, 3601 -> 9532), because bubbles that fan out land in each
  // other's chosen ground. Total debt at forty still fell 318235 -> 40961.
  // A pinned number that only ever moves the good way is a number nobody is
  // reading.
  //
  // The leaders are the PRICE, and they are what the ring spends: they were
  // 23px in every case before it, because the four candidates all sat one
  // 14px offset from the anchor and the placer could not trade distance for
  // clarity at all. It can now, out to `COMMENT_BUBBLE_RING_REACH_PX`.
  it('scores the crowded board as it fills', () => {
    expect({
      five: scoreOf('crowded pitch 168x90, 5 proposals'),
      ten: scoreOf('crowded pitch 168x90, 10 proposals'),
      twenty: scoreOf('crowded pitch 168x90, 20 proposals'),
      forty: scoreOf('crowded pitch 168x90, 40 proposals'),
    }).toEqual({
      five: {
        bubbles: 5,
        cleanBubbles: 5,
        overOwnOutline: 0,
        overOtherOutline: 0,
        overNode: 0,
        overBubble: 0,
        meanLeaderPx: 35,
        maxLeaderPx: 77,
      },
      ten: {
        bubbles: 10,
        cleanBubbles: 10,
        overOwnOutline: 0,
        overOtherOutline: 0,
        overNode: 0,
        overBubble: 0,
        meanLeaderPx: 64,
        maxLeaderPx: 173,
      },
      twenty: {
        bubbles: 20,
        cleanBubbles: 12,
        overOwnOutline: 0,
        overOtherOutline: 0,
        overNode: 9025,
        overBubble: 4856,
        meanLeaderPx: 109,
        maxLeaderPx: 198,
      },
      forty: {
        bubbles: 40,
        cleanBubbles: 22,
        overOwnOutline: 0,
        overOtherOutline: 17163,
        overNode: 14266,
        overBubble: 9532,
        meanLeaderPx: 124,
        maxLeaderPx: 198,
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
        cleanBubbles: 8,
        overPin: 0,
        overNode: 0,
        overBubble: 1371,
        meanLeaderPx: 70,
        maxLeaderPx: 183,
      },
      // The same collapse the proposal layer shows, on the same board: one
      // clean bubble in forty. It was never measured before this case
      // existed, and it is the reason a placer change cannot be judged on
      // the proposal numbers alone.
      crowdedForty: {
        bubbles: 40,
        cleanBubbles: 18,
        overPin: 2804,
        overNode: 27991,
        overBubble: 22034,
        meanLeaderPx: 126,
        maxLeaderPx: 211,
      },
    })
  })
  // The invariant, checked against ids this corpus MINTED rather than
  // inferred from id shape: a bubble may be pushed onto a neighbour's pin
  // when the board leaves nowhere clean, and never onto its own. The four
  // quadrants cleared their own pin by the 14px offset; every ring candidate
  // starts 40px out, so it clears it too — which is why `overPin` above is
  // entirely other comments' pins, and why it is a debt rather than a broken
  // rule.
  it('never covers the pin of the comment it belongs to', () => {
    for (const name of ['spread pitch 220x160, 40 comments', 'crowded pitch 168x90, 40 comments']) {
      const entry = entryOf(name)
      const scene = sceneOf(entry)
      const boxOf = (id: string): BoundingBox | undefined => {
        const node = scene.nodes.find((n) => n.kind === 'shape' && n.id === id)
        return node !== undefined && node.kind === 'shape' ? node.bbox : undefined
      }
      for (const comment of entry.comments) {
        const bubble = boxOf(`${comment.id}/bubble`)
        const pin = boxOf(`${comment.id}/pin`)
        expect(bubble, `${name} ${comment.id} bubble`).toBeDefined()
        expect(pin, `${name} ${comment.id} pin`).toBeDefined()
        if (bubble === undefined || pin === undefined) continue
        const w = Math.min(bubble.x + bubble.w, pin.x + pin.w) - Math.max(bubble.x, pin.x)
        const h = Math.min(bubble.y + bubble.h, pin.y + pin.h) - Math.max(bubble.y, pin.y)
        expect(w > 0 && h > 0 ? w * h : 0, `${name} ${comment.id}`).toBe(0)
      }
    }
  })
})
