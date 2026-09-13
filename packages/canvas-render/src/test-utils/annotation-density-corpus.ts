import type {
  CanvasComment,
  Proposal,
  SpatialCanvas,
  SpatialNode,
} from '@kamiazya/whiteboard-model'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'

/**
 * Boards for the annotation-density scoreboard.
 *
 * It covers BOTH residents of ADR-0026's annotation layer, because they
 * share one bubble placer: a change to `comment-placement.ts` reaches a
 * comment and a proposal alike, and measuring only one of them is how the
 * other's damage goes unseen.
 *
 * ADR-0029 decision 9 says a pile of proposals collapses to a count, and
 * calls that a direction rather than an answer for what a document with
 * forty open proposals looks like. Nothing had drawn one, so this corpus is
 * what makes "does that help" a question with an answer.
 *
 * CROWDING is the axis, not the count. Measured before any change: at a
 * column pitch of 220px the covered fraction barely moves between five
 * proposals and forty (17.1% -> 20.2%), and at a pitch of 168px it goes
 * 28.4% -> 124.6%. A corpus that spreads its nodes out reports a clean
 * score while drawing the same broken picture, so the crowded rows are the
 * ones that carry the finding and the spread row is the control that says
 * a change did not simply move the damage.
 */

/** Every board is this grid, so only the pitch separates the cases. */
const COLS = 8
const NODE_W = 160
const NODE_H = 80
const NODE_COUNT = 40

export interface AnnotationDensityCase {
  readonly name: string
  readonly canvas: SpatialCanvas
  /** Empty on a comment case; a case carries one kind, so a score names one. */
  readonly proposals: readonly Proposal[]
  readonly comments: readonly CanvasComment[]
}

function board(pitchX: number, pitchY: number): SpatialCanvas {
  const nodes: SpatialNode[] = []
  for (let i = 0; i < NODE_COUNT; i += 1) {
    nodes.push(
      textNode({
        id: `n${i}`,
        x: (i % COLS) * pitchX,
        y: Math.floor(i / COLS) * pitchY,
        width: NODE_W,
        height: NODE_H,
        text: `node ${i}`,
      }),
    )
  }
  return { nodes, edges: [] }
}

/**
 * One proposal per targeted node, cycling the three box-shaped verbs so the
 * corpus is not a measurement of `node.remove` alone. Edge changes are
 * deliberately absent: they trace a route rather than occupying a box, so
 * they have no bubble geometry for this scoreboard to score.
 */
function proposalsFor(canvas: SpatialCanvas, count: number): Proposal[] {
  const out: Proposal[] = []
  for (let i = 0; i < count; i += 1) {
    const target = canvas.nodes[i] as SpatialNode
    const id = `c${i}`
    const change =
      i % 3 === 0
        ? {
            id,
            status: 'open' as const,
            op: 'node.remove' as const,
            nodeId: target.id,
            assumed: target,
          }
        : i % 3 === 1
          ? {
              id,
              status: 'open' as const,
              op: 'node.patch' as const,
              nodeId: target.id,
              patch: { x: target.x + 20, y: target.y + 20 },
              assumed: { x: target.x, y: target.y },
            }
          : {
              id,
              status: 'open' as const,
              op: 'node.add' as const,
              node: textNode({
                id: `added${i}`,
                x: target.x + 40,
                y: target.y + 30,
                width: 120,
                height: 60,
                text: `added ${i}`,
              }),
            }
    out.push({ id: `p${i}`, createdAt: '2026-09-06T00:00:00.000Z', changes: [change] })
  }
  return out
}

function caseOf(
  name: string,
  pitchX: number,
  pitchY: number,
  count: number,
): AnnotationDensityCase {
  const canvas = board(pitchX, pitchY)
  return { name, canvas, proposals: proposalsFor(canvas, count), comments: [] }
}

/**
 * One comment per targeted node, anchored where a proposal's outline puts
 * its own anchor — the node's top-right — so the two kinds are placed from
 * the same points and a difference in the score is a difference in what the
 * placer did, not in where it was asked to start.
 */
function commentsFor(canvas: SpatialCanvas, count: number): CanvasComment[] {
  const out: CanvasComment[] = []
  for (let i = 0; i < count; i += 1) {
    const target = canvas.nodes[i] as SpatialNode
    out.push({
      id: `k${i}`,
      x: target.x + target.width,
      y: target.y,
      text: 'looks right to me',
    })
  }
  return out
}

function commentCaseOf(
  name: string,
  pitchX: number,
  pitchY: number,
  count: number,
): AnnotationDensityCase {
  const canvas = board(pitchX, pitchY)
  return { name, canvas, proposals: [], comments: commentsFor(canvas, count) }
}

export const ANNOTATION_DENSITY_CORPUS: readonly AnnotationDensityCase[] = [
  // The control: a board with room, where the placer has always been fine.
  caseOf('spread pitch 220x160, 40 proposals', 220, 160, 40),
  // Crowded, at the counts ADR-0029 names and the ones on the way there.
  caseOf('crowded pitch 168x90, 5 proposals', 168, 90, 5),
  caseOf('crowded pitch 168x90, 10 proposals', 168, 90, 10),
  caseOf('crowded pitch 168x90, 20 proposals', 168, 90, 20),
  caseOf('crowded pitch 168x90, 40 proposals', 168, 90, 40),
  // The placer's OTHER consumer, on the same boards. A comment's bubble is
  // the same geometry placed by the same search, so a change made for the
  // proposal layer lands here whether anyone measured it or not.
  commentCaseOf('spread pitch 220x160, 40 comments', 220, 160, 40),
  commentCaseOf('crowded pitch 168x90, 10 comments', 168, 90, 10),
  commentCaseOf('crowded pitch 168x90, 40 comments', 168, 90, 40),
]
