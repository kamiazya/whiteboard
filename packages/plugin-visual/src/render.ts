/**
 * Everything `visual` contributes to RENDERING, as one ordinary contribution:
 * its silhouettes, how it reads the facets that select them, where it wants a
 * node's text, and what it draws on top.
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
import type {
  BoundingBox,
  NodeDecoration,
  RenderContribution,
  SceneNode,
  ShapeContribution,
} from '@kamiazya/whiteboard-canvas-render'
import type { SpatialNode } from '@kamiazya/whiteboard-model'
import {
  resolveNodeShape,
  resolveNodeSymbol,
  resolveNodeTextAlign,
  VISUAL_SHAPE_KEY,
} from './data.js'

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

/**
 * The silhouettes `visual.shape/v0` selects, under their BARE names — the
 * namespace below composes the ids, so a payload never carries one.
 */
const shapes: Readonly<Record<string, ShapeContribution>> = {
  ellipse: {
    outline: (box) => ({
      kind: 'ellipse',
      cx: box.x + box.w / 2,
      cy: box.y + box.h / 2,
      rx: box.w / 2,
      ry: box.h / 2,
    }),
    // 0.15 rather than the exact (1 - 1/√2)/2 ≈ 0.1464: the exact value puts
    // corners ON the rim, where float error flips containment, and content
    // should not kiss the stroke anyway.
    contentBox: (box) => {
      const dx = box.w * 0.15
      const dy = box.h * 0.15
      return { x: box.x + dx, y: box.y + dy, w: box.w - 2 * dx, h: box.h - 2 * dy }
    },
  },
  diamond: {
    // Edge-midpoint polygon, clockwise from the top vertex — the corner order
    // is fixed for deterministic serialization.
    outline: (box) => {
      const cx = box.x + box.w / 2
      const cy = box.y + box.h / 2
      return {
        kind: 'polygon',
        points: [
          { x: cx, y: box.y },
          { x: box.x + box.w, y: cy },
          { x: cx, y: box.y + box.h },
          { x: box.x, y: cy },
        ],
      }
    },
    contentBox: (box) => ({
      x: box.x + box.w / 4,
      y: box.y + box.h / 4,
      w: box.w / 2,
      h: box.h / 2,
    }),
  },
  hexagon: {
    // Pointy-left-right six-gon, clockwise from the top-left corner. The
    // corner inset is a quarter of the width, capped at half the height so
    // degenerate proportions stay a valid convex polygon.
    outline: (box) => {
      const cy = box.y + box.h / 2
      const inset = Math.min(box.w / 4, box.h / 2)
      return {
        kind: 'polygon',
        points: [
          { x: box.x + inset, y: box.y },
          { x: box.x + box.w - inset, y: box.y },
          { x: box.x + box.w, y: cy },
          { x: box.x + box.w - inset, y: box.y + box.h },
          { x: box.x + inset, y: box.y + box.h },
          { x: box.x, y: cy },
        ],
      }
    },
    contentBox: (box) => insetHorizontally(box),
  },
  parallelogram: {
    // Right-leaning skew, clockwise from the top-left vertex; same capped
    // proportion as the hexagon inset.
    outline: (box) => {
      const skew = Math.min(box.w / 4, box.h / 2)
      return {
        kind: 'polygon',
        points: [
          { x: box.x + skew, y: box.y },
          { x: box.x + box.w, y: box.y },
          { x: box.x + box.w - skew, y: box.y + box.h },
          { x: box.x, y: box.y + box.h },
        ],
      }
    },
    contentBox: (box) => insetHorizontally(box),
  },
  cylinder: {
    outline: (box) => ({
      kind: 'cylinder',
      x: box.x,
      y: box.y,
      w: box.w,
      h: box.h,
      ry: Math.min(box.w * 0.1, box.h / 4),
    }),
    // Gives up the lid (its drawn front rim dips to 2·ry) and the bottom
    // bulge.
    contentBox: (box) => {
      const ry = Math.min(box.w * 0.1, box.h / 4)
      return { x: box.x, y: box.y + 2 * ry, w: box.w, h: box.h - 3 * ry }
    },
  },
}

/** Hexagon and parallelogram give up only their slanted horizontal margins. */
function insetHorizontally(box: BoundingBox): BoundingBox {
  const inset = Math.min(box.w / 4, box.h / 2)
  return { x: box.x + inset, y: box.y, w: box.w - 2 * inset, h: box.h }
}

/**
 * This plugin's whole rendering contribution.
 *
 * `readShape` and `readTextPlacement` are what let the renderer hold no facet
 * key of its own — and they go through the ENGINE (compat chain plus schema),
 * which a raw read of a caller-declared facet key never did.
 */
export const visualRenderContribution: RenderContribution = {
  namespace: VISUAL_SHAPE_KEY.slice(0, VISUAL_SHAPE_KEY.indexOf('.')),
  shapes,
  readShape: resolveNodeShape,
  readTextPlacement: resolveNodeTextAlign,
  decorations: visualDecorations,
}
