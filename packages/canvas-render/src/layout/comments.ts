/**
 * The COMMENT overlay (ADR-0024/0025/0026): where a conversation's pin
 * stands, the outline a region thread draws, and the bubble that says what
 * it holds.
 *
 * Its own module because it is an independently-featured layer that
 * `spatial-canvas.ts` only composes. `comments.test.ts` has had its own
 * identity since before this split and imported the layout entry point
 * because there was nowhere else to import from.
 *
 * It takes the body typesetter as a SEAM rather than importing it: the
 * markdown options a bubble is laid out with are built by the layout core,
 * which recurses back into `layoutSpatialCanvas` for an embedded canvas.
 * Importing it here would close a cycle; taking it as an argument keeps the
 * dependency pointing one way.
 */

import type { CanvasComment, CommentThread, SpatialCanvas } from '@kamiazya/whiteboard-model'
import { isFrame, spatialAnchorRect } from '@kamiazya/whiteboard-model'
import type { BoundingBox, SceneNode } from '@kamiazya/whiteboard-scene'
import { COMMENT_TEXT_MAX_WIDTH_PX, layoutCommentBody } from './comment-body.js'
import {
  commentLeaderEnd,
  nearestPointOnPolyline,
  placeCommentBubble,
} from './comment-placement.js'
import type { RegionChrome, ResolvedLayoutOptions } from './layout-options.js'
import type { SpatialCommentAppearance } from './nodes/spatial-appearance.js'
import { contentExtent } from './scene-extent.js'
import { translateScene } from './translate-scene.js'

/**
 * How a bubble's markdown body is typeset. Supplied by the layout core,
 * which is the only thing that can build it — see this module's header for
 * why it is a seam rather than an import.
 */
export type BodyLayoutSeam = (
  maxWidth: number,
  options: ResolvedLayoutOptions,
) => Parameters<typeof layoutCommentBody>[1]

/** Pin diameter (px). Fixed like badge geometry — a mark, not content. */
export const COMMENT_PIN_SIZE_PX = 20

/**
 * The digits on a pin. Sized to sit inside the 20px pin with its 2px ring
 * and still read — the same relation the source pane's 12px gutter dot has
 * to its 9px count.
 */
export const COMMENT_PIN_COUNT_FONT_PX = 10

// Exported with the offset so the editor's compose bubble can wear the same
// box the renderer draws (padding, corner) — the draft and the settled
// comment are one object, not two that happen to look alike.
export const COMMENT_BUBBLE_PADDING_PX = 8
export const COMMENT_BUBBLE_RADIUS_PX = 8

/** The routed path of an edge, by id, as the layout drew it — absent when the edge is gone. */
export type EdgePathLookup = (edgeId: string) => readonly { x: number; y: number }[] | undefined

/**
 * Where a comment points: the target node's top-right corner while the node
 * exists (the pin FOLLOWS the node); the point of the target edge's routed
 * path nearest the stored anchor while the edge exists (the pin RIDES the
 * edge through a reroute); the stored anchor otherwise. The fallback is what
 * makes a dangling target harmless, per the model's contract that a comment
 * may outlive its subject.
 *
 * Exported because the editor places its compose bubble and its edit bubble
 * at the same anchor this layer draws from — one producer for the geometry,
 * so the draft cannot open one place and settle another. The editor passes
 * the paths it already flattened for hit-testing as `edgePathOf`; without
 * one, an edge comment stands at its stored point.
 */
export function commentAnchor(
  comment: CanvasComment,
  canvas: SpatialCanvas,
  edgePathOf?: EdgePathLookup,
): { readonly x: number; readonly y: number } {
  if (comment.targetNodeId !== undefined) {
    const target = canvas.nodes.find((node) => node.id === comment.targetNodeId)
    if (target !== undefined) return { x: target.x + target.width, y: target.y }
  }
  if (comment.targetEdgeId !== undefined) {
    const path = edgePathOf?.(comment.targetEdgeId)
    if (path !== undefined && path.length > 0) {
      return nearestPointOnPolyline({ x: comment.x, y: comment.y }, path)
    }
  }
  return { x: comment.x, y: comment.y }
}

/** A node set or region thread, with the box it stands for on this canvas. */

export function regionsOf(
  threads: readonly CommentThread[],
  canvas: SpatialCanvas,
): ReadonlyMap<string, RegionChrome> {
  const nodeById = (id: string) => canvas.nodes.find((node) => node.id === id)
  const out = new Map<string, RegionChrome>()
  for (const thread of threads) {
    if (thread.anchor.kind !== 'spatial') continue
    const rect = spatialAnchorRect(thread.anchor, nodeById)
    if (rect !== undefined) out.set(thread.id, { rect, resolved: thread.status === 'resolved' })
  }
  return out
}

/** Outline radius (px): the pin's, so the chrome reads as one family. */
const REGION_OUTLINE_RADIUS_PX = 6

/**
 * One dashed outline per node set or region: the box the conversation is
 * about, drawn so its pin has something to point at. Ids `${threadId}/region`
 * and `commentChrome: true`, like the pin. Resolved ones follow the pin's
 * rule — drawn muted under `showResolved`, otherwise not at all.
 */
export function composeRegionOutlines(options: ResolvedLayoutOptions): readonly SceneNode[] {
  const chrome = options.appearance.resolveComment?.()
  const out: SceneNode[] = []
  for (const [threadId, { rect, resolved }] of options.regionsByThread) {
    if (resolved && options.showResolved !== true) continue
    const appearance = resolved ? chrome?.resolvedOverlay.region : chrome?.region
    out.push({
      kind: 'shape',
      id: `${threadId}/region`,
      commentChrome: true,
      bbox: { x: rect.x, y: rect.y, w: rect.width, h: rect.height },
      radius: REGION_OUTLINE_RADIUS_PX,
      ...(appearance !== undefined ? { appearance } : {}),
    })
  }
  return out
}

/**
 * The comment annotation layer (ADR-0024 decision 4): one pin (a circle on
 * the anchor) plus one bubble (rounded rect holding the text, floating
 * offset from the anchor) per unresolved comment, composed from existing
 * scene kinds so no consumer of the closed union changes. Resolved comments
 * stay in the document and are drawn only when `options.showResolved` is set
 * (ADR-0025 decision 2), muted via the resolver's `resolvedOverlay`.
 * Appearance comes from the resolver's optional `resolveComment` — assigned,
 * never invented — so a resolver that predates the layer still lays
 * comments out, bare.
 *
 * The pin and bubble carry ids (`${comment.id}/pin`, `${comment.id}/bubble`,
 * mirroring the leader's `${comment.id}/leader`) so the editor can hit-test
 * them, and `commentChrome: true` so `sceneDigest` can tell them apart from
 * an addressable document node despite carrying an id of their own (see
 * `ShapeSceneNode.commentChrome`).
 *
 * Bubbles are placed by `placeCommentBubble`: down-right of the anchor
 * unless that would cover a node or an earlier comment's bubble, then the
 * least-covered quadrant. Group frames are not obstacles — a comment inside
 * a group is about its members, and pushing the bubble out of the frame
 * would carry it away from them. Document order decides who yields:
 * a later comment fans out around an earlier one.
 */
/**
 * What a bubble must not cover. Nodes and whatever the caller adds, plus
 * EVERY pin up front — not each one as its comment is drawn. A pin is what
 * its comment is about, so a bubble covering one hides exactly what a reader
 * followed the leader to find. Seeding them all is what makes that true for
 * a comment drawn BEFORE the pin it would have covered; pushing each pin as
 * it is emitted only protects the ones after it.
 *
 * This did not matter while the placer had four candidates a fixed 14px from
 * the anchor, which clear their own pin and reach no other. It matters now:
 * measured on the crowded forty-comment board, the ring put 3948 square
 * pixels of bubble over other comments' pins.
 *
 * Group frames are not obstacles — a comment inside a group is about its
 * members, and pushing the bubble out of the frame would carry it away.
 */
function bubbleObstacles(
  canvas: SpatialCanvas,
  options: ResolvedLayoutOptions,
  visible: readonly CanvasComment[],
  anchorOf: (comment: CanvasComment) => { x: number; y: number },
): BoundingBox[] {
  return [
    ...canvas.nodes
      .filter((node) => !isFrame(node))
      .map((node) => ({ x: node.x, y: node.y, w: node.width, h: node.height })),
    ...(options.commentObstacles ?? []),
    // EVERY pin, up front — not each one as its comment is drawn. A pin is
    // what its comment is about, so a bubble covering one hides exactly what
    // a reader followed the leader to find. Seeding them all is what makes
    // that true for a comment drawn BEFORE the pin it would have covered;
    // pushing each pin as it is emitted only protects the ones after it.
    //
    // This did not matter while the placer had four candidates a fixed 14px
    // from the anchor, which clear their own pin and reach no other. It
    // matters now: measured on the crowded forty-comment board, the ring
    // put 3948 square pixels of bubble over other comments' pins.
    ...visible.map((comment) => {
      const anchor = anchorOf(comment)
      return {
        x: anchor.x - COMMENT_PIN_SIZE_PX / 2,
        y: anchor.y - COMMENT_PIN_SIZE_PX / 2,
        w: COMMENT_PIN_SIZE_PX,
        h: COMMENT_PIN_SIZE_PX,
      }
    }),
  ]
}

/**
 * The digit on a pin, past one message only — the same rule the rail's row,
 * the source pane's gutter and the preview marker follow: a digit beside
 * every lone remark is noise, and the number only says something once there
 * is more than one. `undefined` is "no digit", not "no appearance".
 */
function pinCountRun(
  comment: CanvasComment,
  anchor: { x: number; y: number },
  options: ResolvedLayoutOptions,
  chrome: SpatialCommentAppearance | undefined,
): SceneNode | undefined {
  const count = options.messagesByThread.get(comment.id) ?? 1
  if (count <= 1) return undefined
  const countAppearance =
    comment.resolved === true ? chrome?.resolvedOverlay?.pinCount : chrome?.pinCount
  const text = String(count)
  // Family from the resolver and size from geometry, the same split the
  // edge label makes: this package assigns paint, never invents it, and
  // a size is geometry rather than paint.
  const metrics = options.measure(text, {
    family: countAppearance?.fontFamily ?? 'sans-serif',
    fallbackChain: [],
    weight: 400,
    style: 'normal',
    sizePx: COMMENT_PIN_COUNT_FONT_PX,
  })
  const w = metrics.advanceWidth
  const h = metrics.ascent + metrics.descent
  return {
    kind: 'textRun',
    bbox: { x: anchor.x - w / 2, y: anchor.y - h / 2, w, h },
    baseline: metrics.ascent,
    text,
    ...(countAppearance === undefined
      ? {}
      : { appearance: { ...countAppearance, fontSize: COMMENT_PIN_COUNT_FONT_PX } }),
  }
}

export function composeComments(
  canvas: SpatialCanvas,
  options: ResolvedLayoutOptions,
  edgePathOf: EdgePathLookup,
  bodyLayout: BodyLayoutSeam,
): readonly SceneNode[] {
  const comments = options.comments ?? canvas.comments
  if (comments === undefined || comments.length === 0) return []

  const chrome = options.appearance.resolveComment?.()
  const visible = comments.filter(
    (comment) => comment.resolved !== true || options.showResolved === true,
  )
  const anchorOf = (comment: (typeof visible)[number]): { x: number; y: number } => {
    // A node set's pin stands at the corner of the box its LIVE nodes
    // occupy, read from the thread: the flat projection's point is where
    // that box was when it was last projected, and the nodes move.
    const region = options.regionsByThread.get(comment.id)
    return region !== undefined
      ? { x: region.rect.x + region.rect.width, y: region.rect.y }
      : commentAnchor(comment, canvas, edgePathOf)
  }
  const obstacles = bubbleObstacles(canvas, options, visible, anchorOf)
  const out: SceneNode[] = []
  for (const comment of visible) {
    // Assigned, never invented: a resolved comment's muting comes only from
    // the theme's `resolvedOverlay`, never from an opacity literal here. A
    // bare resolver (no `resolveComment`) still composes full geometry with
    // no appearance at all, resolved or not.
    const appearance = comment.resolved === true ? chrome?.resolvedOverlay : chrome
    const anchor = anchorOf(comment)

    // Through `layoutCommentBody`, which is the ONE producer of a comment's
    // prose — so the card and rail that draw this same body in the web app
    // cannot pick different metrics for it.
    const laid = layoutCommentBody(comment.text, {
      ...bodyLayout(COMMENT_TEXT_MAX_WIDTH_PX, options),
      parseBody: options.parseBody,
      onParseFailure: (err) =>
        options.onDegrade?.({ kind: 'body-parse-failed', nodeId: comment.id, err }),
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

    // The leader FIRST, so pin and bubble paint over its ends: a dashed line
    // from the anchor to the bubble's near corner keeps the pair reading as
    // one comment when a dense canvas separates them. Geometry is composed
    // for every resolver; only its paint is assigned.
    out.push({
      kind: 'edge',
      id: `${comment.id}/leader`,
      commentChrome: true,
      path: [
        { x: anchor.x, y: anchor.y },
        commentLeaderEnd(anchor, bubble, COMMENT_BUBBLE_RADIUS_PX),
      ],
      fromSide: 'right',
      toSide: 'left',
      fromEnd: 'none',
      toEnd: 'none',
      ...(appearance !== undefined ? { appearance: appearance.leader } : {}),
    })

    out.push({
      kind: 'shape',
      id: `${comment.id}/pin`,
      commentChrome: true,
      bbox: {
        x: anchor.x - COMMENT_PIN_SIZE_PX / 2,
        y: anchor.y - COMMENT_PIN_SIZE_PX / 2,
        w: COMMENT_PIN_SIZE_PX,
        h: COMMENT_PIN_SIZE_PX,
      },
      radius: COMMENT_PIN_SIZE_PX / 2,
      ...(appearance !== undefined ? { appearance: appearance.pin } : {}),
    })

    const countRun = pinCountRun(comment, anchor, options, chrome)
    if (countRun !== undefined) out.push(countRun)

    out.push({
      kind: 'shape',
      id: `${comment.id}/bubble`,
      commentChrome: true,
      bbox: bubble,
      radius: COMMENT_BUBBLE_RADIUS_PX,
      ...(appearance !== undefined ? { appearance: appearance.bubble } : {}),
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
