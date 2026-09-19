/**
 * The PROPOSAL overlay (ADR-0029 decision 1): every open change outlined
 * where it would land, and one bubble per proposal.
 *
 * Split from `spatial-canvas.ts` beside the comment layer and for the same
 * reason — a separately-featured overlay with its own test file. It reuses
 * the comment layer's constants and grammar deliberately, which is why it
 * imports them rather than restating them, and it takes the same
 * body-typesetting seam for the same reason.
 */

import type {
  EdgeEnd,
  LineEnd,
  SpatialCanvas,
  SpatialNode,
  SpatialProposedChange,
} from '@kamiazya/whiteboard-model'
import { canvasChangeConflicts, endNode } from '@kamiazya/whiteboard-model'
import type { BoundingBox, SceneNode } from '@kamiazya/whiteboard-scene'
import { layoutCommentBody, PROPOSAL_TEXT_MAX_WIDTH_PX } from './comment-body.js'
import { commentLeaderEnd, placeCommentBubble } from './comment-placement.js'
import {
  type BodyLayoutSeam,
  COMMENT_BUBBLE_PADDING_PX,
  COMMENT_BUBBLE_RADIUS_PX,
  type EdgePathLookup,
} from './comments.js'
import type { ResolvedLayoutOptions } from './layout-options.js'
import { contentExtent } from './scene-extent.js'
import { translateScene } from './translate-scene.js'

/**
 * The proposal layer (ADR-0029 decision 1): every OPEN change outlined where
 * it would land, and one bubble per proposal saying what it would do.
 *
 * Drawn on the live document rather than in a preview of a second one — that
 * is the decision, and the reason the whole variation surface was retired.
 * The bubble reuses the comment layer's constants and grammar deliberately:
 * a reader who has used a comment has already learned how to read this, and
 * two sets of numbers for one visual language would drift.
 *
 * A DECIDED change draws nothing. It stays in the record because what closed
 * it is part of what happened to the document, but it is no longer asking
 * for anything, and a proposal whose changes are all decided has no bubble.
 *
 * The verbs live in the editor's context menu on this chrome, the way a
 * comment is resolved — the bubble says how many and whether any needs a
 * look, and the menu is where the deciding happens.
 */
export function composeProposals(
  canvas: SpatialCanvas,
  options: ResolvedLayoutOptions,
  edgePathOf: EdgePathLookup,
  bodyLayout: BodyLayoutSeam,
): readonly SceneNode[] {
  const proposals = options.proposals
  if (proposals === undefined || proposals.length === 0) return []
  const chrome = options.appearance.resolveProposal?.()
  const paint = chrome === undefined ? {} : { appearance: chrome.outline }
  const obstacles: BoundingBox[] = canvas.nodes
    .filter((node) => node.type !== 'group')
    .map((node) => ({ x: node.x, y: node.y, w: node.width, h: node.height }))
  const out: SceneNode[] = []

  for (const proposal of proposals) {
    const open = proposal.changes.filter((change) => change.status === 'open')
    if (open.length === 0) continue
    let anchor: { x: number; y: number } | undefined
    let conflicts = 0

    for (const change of open) {
      if (change.op === 'body.replace') continue
      if (canvasChangeConflicts(change, canvas)) conflicts += 1
      const box = proposedBox(change, canvas)
      if (box !== undefined) {
        out.push({
          kind: 'shape',
          id: `${change.id}/outline`,
          proposalChrome: { proposalId: proposal.id },
          bbox: box,
          radius: COMMENT_BUBBLE_RADIUS_PX,
          ...paint,
        })
        obstacles.push(box)
        anchor ??= { x: box.x + box.w, y: box.y }
        continue
      }
      const path = proposedEdgePath(change, canvas, edgePathOf)
      if (path === undefined) continue
      out.push({
        kind: 'edge',
        id: `${change.id}/outline`,
        path,
        fromSide: 'right',
        toSide: 'left',
        fromEnd: 'none',
        toEnd: 'none',
        ...paint,
      })
      anchor ??= path[Math.floor(path.length / 2)]
    }
    if (anchor === undefined) continue

    const changed = `${open.length} proposed change${open.length === 1 ? '' : 's'}`
    const label = conflicts === 0 ? changed : `${changed}, ${conflicts} needs a look`
    // Through the comment body's own producer, so the label WRAPS instead of
    // being truncated at the bubble's width — "2 proposed changes - 1 needs
    // a look" does not fit on one line, and a truncated count is worse than
    // no count. This bubble borrows the comment layer's grammar throughout;
    // borrowing its producer is what keeps that true.
    const laid = layoutCommentBody(label, {
      ...bodyLayout(PROPOSAL_TEXT_MAX_WIDTH_PX, options),
      density: 'compact',
      parseBody: options.parseBody,
      onParseFailure: (err) =>
        options.onDegrade?.({ kind: 'body-parse-failed', nodeId: proposal.id, err }),
    })
    const { right: contentRight, bottom: contentBottom } = contentExtent(laid.nodes)
    const bubble = placeCommentBubble(
      anchor,
      {
        w: contentRight + 2 * COMMENT_BUBBLE_PADDING_PX,
        h: contentBottom + 2 * COMMENT_BUBBLE_PADDING_PX,
      },
      obstacles,
    )
    obstacles.push(bubble)

    out.push({
      kind: 'edge',
      id: `${proposal.id}/leader`,
      path: [
        { x: anchor.x, y: anchor.y },
        commentLeaderEnd(anchor, bubble, COMMENT_BUBBLE_RADIUS_PX),
      ],
      fromSide: 'right',
      toSide: 'left',
      fromEnd: 'none',
      toEnd: 'none',
      ...(chrome === undefined ? {} : { appearance: chrome.leader }),
    })
    out.push({
      kind: 'shape',
      id: `${proposal.id}/bubble`,
      proposalChrome: { proposalId: proposal.id },
      bbox: bubble,
      radius: COMMENT_BUBBLE_RADIUS_PX,
      ...(chrome === undefined ? {} : { appearance: chrome.bubble }),
    })
    out.push(
      ...translateScene(
        laid,
        bubble.x + COMMENT_BUBBLE_PADDING_PX,
        bubble.y + COMMENT_BUBBLE_PADDING_PX,
      ).nodes,
    )
  }
  return out
}

/**
 * The box a change concerns: where an addition would appear, where a patch
 * would leave the element, and where a removal would take it from. A patch
 * is drawn at its DESTINATION and the element stays where it is — the
 * outline is what says "there", and moving the node would be applying the
 * proposal rather than showing it.
 *
 * `undefined` for an edge arm, which has a route rather than a box.
 */
function proposedBox(
  change: SpatialProposedChange,
  canvas: SpatialCanvas,
): BoundingBox | undefined {
  const boxOf = (node: SpatialNode): BoundingBox => ({
    x: node.x,
    y: node.y,
    w: node.width,
    h: node.height,
  })
  switch (change.op) {
    case 'node.add':
      return boxOf(change.node)
    case 'node.patch': {
      const node = canvas.nodes.find((candidate) => candidate.id === change.nodeId)
      return node === undefined ? undefined : boxOf({ ...node, ...change.patch })
    }
    case 'node.remove': {
      const node = canvas.nodes.find((candidate) => candidate.id === change.nodeId)
      return node === undefined ? undefined : boxOf(node)
    }
    default:
      return undefined
  }
}

/**
 * The route a proposed edge change traces. An edge already on the board is
 * traced along the route it was ROUTED to, so the chrome sits on the line a
 * reader can see; one that does not exist yet has no route, so it is drawn
 * straight between the centres of the nodes it would join — honest as a
 * preview, and visibly not the finished routing.
 */
function proposedEdgePath(
  change: SpatialProposedChange,
  canvas: SpatialCanvas,
  edgePathOf: EdgePathLookup,
): readonly { x: number; y: number }[] | undefined {
  if (change.op === 'edge.patch' || change.op === 'edge.remove') {
    return edgePathOf(change.edgeId)
  }
  // Ink already on the board is traced the same way, and for the same
  // reason: `composeEdgesAndLabels` routes lines through the edge pipeline,
  // so a line's id is in the same path table (ADR-0038 decision 2).
  if (change.op === 'line.patch' || change.op === 'line.remove') {
    return edgePathOf(change.lineId)
  }
  if (change.op === 'line.add') {
    const at = (end: LineEnd) => {
      if (end.kind === 'point') return end.point
      const node = canvas.nodes.find((candidate) => candidate.id === end.node)
      return node === undefined
        ? undefined
        : { x: node.x + node.width / 2, y: node.y + node.height / 2 }
    }
    const from = at(change.line.from)
    const to = at(change.line.to)
    return from === undefined || to === undefined ? undefined : [from, to]
  }
  if (change.op !== 'edge.add') return undefined
  // A FREE end has no box to take a centre from, so a proposed edge carrying
  // one draws no preview line — the same answer a dangling reference gets.
  const centre = (end: EdgeEnd) => {
    const id = endNode(end)
    const node = id === undefined ? undefined : canvas.nodes.find((c) => c.id === id)
    return node === undefined
      ? undefined
      : { x: node.x + node.width / 2, y: node.y + node.height / 2 }
  }
  const from = centre(change.edge.from)
  const to = centre(change.edge.to)
  return from === undefined || to === undefined ? undefined : [from, to]
}
