import type { BoundingBox, Scene, SceneNode, ShapeSceneNode } from '@kamiazya/whiteboard-scene'

/**
 * The annotation-density scoreboard's independent oracle, for both
 * residents of ADR-0026's annotation layer.
 *
 * It reads GEOMETRY off the scene and never calls `comment-placement.ts`'s
 * own `coveredArea`, so a broken placement rule cannot satisfy the
 * scoreboard by agreeing with itself (same contract as `routing-metrics.ts`
 * and `text-wrapping-metrics.ts`).
 *
 * DEBT metrics target zero: a bubble covering anything is a bubble hiding
 * something a reader came for. PRICE metrics have no target — a leader is
 * how far a bubble sits from what it is about, and buying less overlap with
 * a longer leader is a trade someone has to make on purpose rather than by
 * accident.
 */

/** What a comment's bubbles cost on the same boards, on the terms a comment has. */
export interface CommentDensityScore {
  readonly overPin: number
  readonly overNode: number
  readonly overBubble: number
  readonly cleanBubbles: number
  readonly bubbles: number
  readonly meanLeaderPx: number
  readonly maxLeaderPx: number
}

export interface ProposalDensityScore {
  /** Debt: bubble over the outline of a change in its OWN proposal. */
  readonly overOwnOutline: number
  /** Debt: bubble over another proposal's outline. */
  readonly overOtherOutline: number
  /** Debt: bubble over a canvas node. */
  readonly overNode: number
  /** Debt: bubble over another bubble. */
  readonly overBubble: number
  /** Debt: how many bubbles have zero coverage of any kind. */
  readonly cleanBubbles: number
  /** How many bubbles the scene drew at all — the denominator for the rest. */
  readonly bubbles: number
  /** Price: mean centre-to-anchor distance, rounded to a whole pixel. */
  readonly meanLeaderPx: number
  /** Price: the longest of those. */
  readonly maxLeaderPx: number
}

/**
 * Chrome is identified by the marker it carries, never by the shape of its
 * id: an outline's id names its CHANGE and only a bubble's names the
 * proposal, so `proposalChrome.proposalId` is the one thing that says whose
 * a chrome node is.
 */
interface Chrome {
  readonly proposalId: string
  readonly bbox: BoundingBox
}

function overlap(a: BoundingBox, b: BoundingBox): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)
  return w > 0 && h > 0 ? w * h : 0
}

const isShape = (node: SceneNode): node is ShapeSceneNode => node.kind === 'shape'

/**
 * The bubble is the chrome node whose id ends `/bubble`; every other shape
 * carrying the marker is an outline. That split IS positional, and it is
 * the one place it can be: the two are told apart by what they are FOR, and
 * only the composer knows which it just emitted.
 */
function splitChrome(scene: Scene): { bubbles: Chrome[]; outlines: Chrome[] } {
  const bubbles: Chrome[] = []
  const outlines: Chrome[] = []
  for (const node of scene.nodes) {
    if (!isShape(node) || node.proposalChrome === undefined) continue
    const chrome = { proposalId: node.proposalChrome.proposalId, bbox: node.bbox }
    if (node.id?.endsWith('/bubble') === true) bubbles.push(chrome)
    else outlines.push(chrome)
  }
  return { bubbles, outlines }
}

export function scoreProposalDensity(
  scene: Scene,
  nodeBoxes: readonly BoundingBox[],
): ProposalDensityScore {
  const { bubbles, outlines } = splitChrome(scene)
  let overOwnOutline = 0
  let overOtherOutline = 0
  let overNode = 0
  let overBubble = 0
  let clean = 0

  for (const [index, bubble] of bubbles.entries()) {
    let covered = 0
    for (const outline of outlines) {
      const area = overlap(bubble.bbox, outline.bbox)
      if (area === 0) continue
      covered += area
      if (outline.proposalId === bubble.proposalId) overOwnOutline += area
      else overOtherOutline += area
    }
    for (const box of nodeBoxes) {
      const area = overlap(bubble.bbox, box)
      covered += area
      overNode += area
    }
    for (const [otherIndex, other] of bubbles.entries()) {
      if (otherIndex === index) continue
      const area = overlap(bubble.bbox, other.bbox)
      covered += area
      // Each unordered pair is visited twice, so halve it here rather than
      // reporting a bubble-over-bubble figure twice the painted truth.
      overBubble += area / 2
    }
    if (covered === 0) clean += 1
  }

  const leaders = leaderLengths(scene, bubbles.length)
  return {
    overOwnOutline: Math.round(overOwnOutline),
    overOtherOutline: Math.round(overOtherOutline),
    overNode: Math.round(overNode),
    overBubble: Math.round(overBubble),
    cleanBubbles: clean,
    bubbles: bubbles.length,
    meanLeaderPx:
      leaders.length === 0
        ? 0
        : Math.round(leaders.reduce((sum, value) => sum + value, 0) / leaders.length),
    maxLeaderPx: leaders.length === 0 ? 0 : Math.round(Math.max(...leaders)),
  }
}

/**
 * A leader is drawn as a two-point edge from the anchor to the bubble, so
 * its own geometry is the honest measure of how far a reader's eye travels
 * — no need to re-derive an anchor the composer already resolved.
 */
function leaderLengths(scene: Scene, bubbleCount: number): number[] {
  if (bubbleCount === 0) return []
  const out: number[] = []
  for (const node of scene.nodes) {
    if (node.kind !== 'edge' || node.id?.endsWith('/leader') !== true) continue
    const from = node.path[0]
    const to = node.path[node.path.length - 1]
    if (from === undefined || to === undefined) continue
    out.push(Math.hypot(to.x - from.x, to.y - from.y))
  }
  return out
}

/**
 * A comment has a PIN where a proposal has an outline, and one bubble per
 * comment rather than one per proposal — so there is no own-versus-other
 * split to make, and covering ANY pin is the same defect. The terms that do
 * carry over are the ones the placer decides: node, bubble, and how far the
 * bubble ended up from what it is about.
 */
export function scoreCommentDensity(
  scene: Scene,
  nodeBoxes: readonly BoundingBox[],
): CommentDensityScore {
  const bubbles: BoundingBox[] = []
  const pins: BoundingBox[] = []
  for (const node of scene.nodes) {
    if (!isShape(node) || node.commentChrome !== true) continue
    if (node.id?.endsWith('/bubble') === true) bubbles.push(node.bbox)
    else if (node.id?.endsWith('/pin') === true) pins.push(node.bbox)
  }

  let overPin = 0
  let overNode = 0
  let overBubble = 0
  let clean = 0
  for (const [index, bubble] of bubbles.entries()) {
    let covered = 0
    for (const pin of pins) {
      const area = overlap(bubble, pin)
      covered += area
      overPin += area
    }
    for (const box of nodeBoxes) {
      const area = overlap(bubble, box)
      covered += area
      overNode += area
    }
    for (const [otherIndex, other] of bubbles.entries()) {
      if (otherIndex === index) continue
      const area = overlap(bubble, other)
      covered += area
      overBubble += area / 2
    }
    if (covered === 0) clean += 1
  }

  const leaders = leaderLengths(scene, bubbles.length)
  return {
    overPin: Math.round(overPin),
    overNode: Math.round(overNode),
    overBubble: Math.round(overBubble),
    cleanBubbles: clean,
    bubbles: bubbles.length,
    meanLeaderPx:
      leaders.length === 0
        ? 0
        : Math.round(leaders.reduce((sum, value) => sum + value, 0) / leaders.length),
    maxLeaderPx: leaders.length === 0 ? 0 : Math.round(Math.max(...leaders)),
  }
}
