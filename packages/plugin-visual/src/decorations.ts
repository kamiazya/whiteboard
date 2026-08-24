/**
 * What `visual` draws ON a node, as an ordinary decoration contribution.
 *
 * This used to live inside `canvas-render`, which meant the renderer knew
 * what a badge is, how big it is and where it sits — all of them this
 * plugin's business, and none of them reachable by another plugin wanting a
 * mark of its own.
 *
 * The scene-node vocabulary is imported TYPE-ONLY. `canvas-render` depends on
 * this package at runtime (it supplies these as its default), so a runtime
 * import back would close a cycle; a type import is erased and closes
 * nothing.
 *
 * ponytail: the honest fix is a package below both holding the scene
 * vocabulary, since it is a contract between the renderer and every plugin
 * rather than the renderer's private type. Worth extracting when a second
 * plugin needs it; today it would move ~420 lines to serve one caller.
 */
import type { BoundingBox, NodeDecoration, SceneNode } from '@kamiazya/whiteboard-canvas-render'
import type { SpatialNode } from '@kamiazya/whiteboard-model'
import { resolveNodeSymbol } from './data.js'

const BADGE_SIZE_PX = 16
const BADGE_MARGIN_PX = 4

/**
 * `visual.symbol/v0` as a badge in the content box's top-right corner.
 *
 * The badge plus its margin must FIT: pricing the glyph alone let an 18px-wide
 * node place a 16px badge at x = -2, painting it outside the node the badge is
 * supposed to mark.
 */
export const symbolBadge: NodeDecoration = (node: SpatialNode, context) => {
  const symbol = resolveNodeSymbol(node)
  if (symbol === undefined) return []
  const { bounds } = context
  if (bounds.w < BADGE_SIZE_PX + BADGE_MARGIN_PX || bounds.h < BADGE_SIZE_PX + BADGE_MARGIN_PX) {
    return []
  }
  const bbox: BoundingBox = {
    x: bounds.x + bounds.w - BADGE_MARGIN_PX - BADGE_SIZE_PX,
    y: bounds.y + BADGE_MARGIN_PX,
    w: BADGE_SIZE_PX,
    h: BADGE_SIZE_PX,
  }
  if (symbol.kind === 'emoji') {
    const glyph: SceneNode = { kind: 'glyph', bbox, glyph: symbol.char }
    return [glyph]
  }
  const icon: SceneNode = {
    kind: 'icon',
    bbox,
    icon: symbol.name,
    // Matches the label ink, so a badge reads as part of the node's text
    // rather than as chrome.
    ...(context.label.fill === undefined ? {} : { appearance: { stroke: context.label.fill } }),
  }
  return [icon]
}

/** Everything this plugin draws on a node. */
export const visualDecorations: readonly NodeDecoration[] = [symbolBadge]
