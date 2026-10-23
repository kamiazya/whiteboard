/**
 * Everything `visual` contributes to RENDERING, as one ordinary contribution:
 * its silhouettes, how it reads the facets that select them, and where it
 * wants a node's text.
 *
 * It lives here, not in `canvas-render`, so the renderer knows nothing of a
 * plugin's business — what its silhouettes are and which facet selects one.
 *
 * Its one decoration is the badge a stencil-wearing box carries. A symbol set
 * by hand is NOT drawn on the node: it reaches the surfaces a node is too
 * small to read on (the tab's favicon, the file row, the canvas overview),
 * where a mark is the only thing that can say which box it is. A stencil is a
 * kind, and the mark is how two kinds with a similar silhouette stay apart.
 *
 * The contract comes from `@kamiazya/whiteboard-scene`, which sits BELOW
 * both this package and the renderer, so there is no package cycle to hold
 * open and no guard to keep honest.
 */
import type {
  BoundingBox,
  NodeDecoration,
  RenderContribution,
  ShapeContribution,
} from '@kamiazya/whiteboard-scene'
import { resolveNodeStencil } from './apply-stencil.js'
import {
  resolveCanvasTheme,
  resolveNodeShape,
  resolveNodeSymbol,
  resolveNodeTextAlign,
  VISUAL_SHAPE_KEY,
} from './data.js'
import { VISUAL_THEMES } from './themes.js'

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
  octagon: {
    // A rectangle with its four corners taken off — the polygon nearest to
    // the rounded rectangle every notation draws a running component as,
    // and `NodeOutline` (a `packages/scene` contract) has no rounded-rect
    // kind. Clockwise from the top-left cut.
    //
    // A SYMMETRIC cut off the smaller dimension, not the hexagon's
    // `min(w/4, h/2)`: the point of this silhouette is that it still reads
    // as a rectangle, and a cut sized off the width alone eats a flat box's
    // whole height. It is also what keeps the two apart — at 200x80 the
    // hexagon's points run 40px in from each end while this cuts 20px off
    // each corner, leaving real vertical edges the hexagon does not have.
    outline: (box) => {
      const cut = octagonCut(box)
      return {
        kind: 'polygon',
        points: [
          { x: box.x + cut, y: box.y },
          { x: box.x + box.w - cut, y: box.y },
          { x: box.x + box.w, y: box.y + cut },
          { x: box.x + box.w, y: box.y + box.h - cut },
          { x: box.x + box.w - cut, y: box.y + box.h },
          { x: box.x + cut, y: box.y + box.h },
          { x: box.x, y: box.y + box.h - cut },
          { x: box.x, y: box.y + cut },
        ],
      }
    },
    // Half the cut on every side puts each corner exactly ON its diagonal
    // (`cut/2 / cut + cut/2 / cut = 1`), which counts as inside — the same
    // exact-boundary inscription the diamond already uses.
    contentBox: (box) => {
      const half = octagonCut(box) / 2
      return { x: box.x + half, y: box.y + half, w: box.w - 2 * half, h: box.h - 2 * half }
    },
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

/**
 * The octagon's corner cut, off the SMALLER dimension so the shape survives
 * any proportion: a quarter of it is pronounced enough to read as a cut
 * corner and never large enough to make two cuts meet.
 */
const octagonCut = (box: BoundingBox): number => Math.min(box.w, box.h) / 4

/** Hexagon and parallelogram give up only their slanted horizontal margins. */
function insetHorizontally(box: BoundingBox): BoundingBox {
  const inset = Math.min(box.w / 4, box.h / 2)
  return { x: box.x + inset, y: box.y, w: box.w - 2 * inset, h: box.h }
}

/** Edge of a stencil's badge, and its distance from the node's top edge. */
const BADGE_SIZE_PX = 16
const BADGE_INSET_PX = 6
/** Below this node height the badge would sit on the label, so it is left off. */
const BADGE_MIN_NODE_HEIGHT_PX = 48

/**
 * The mark a box wearing a stencil carries, at the top centre where every
 * silhouette here is at its widest-clear: a corner is outside a diamond, an
 * ellipse and a parallelogram, the top edge's middle is inside all six.
 * Only a stencil-wearing box draws it — a symbol set by hand keeps reaching
 * the minimap, the favicon and the file row alone, so a plain box someone
 * marked is not redrawn. A stencil is a kind, and two kinds that differ only
 * by silhouette (octagon beside hexagon) are hard to tell apart at a glance;
 * the mark is the second signal that does not depend on colour.
 */
const stencilBadge: NodeDecoration = (node, { label }) => {
  if (resolveNodeStencil(node) === undefined) return []
  const symbol = resolveNodeSymbol(node)
  if (symbol?.kind !== 'icon' || node.height < BADGE_MIN_NODE_HEIGHT_PX) return []
  return [
    {
      kind: 'icon',
      icon: symbol.name,
      // An icon is STROKED, and a `<use>` with no stroke draws nothing: the
      // label's ink is what the badge shares a box with.
      appearance: { stroke: label.fill ?? 'currentColor' },
      bbox: {
        x: node.x + (node.width - BADGE_SIZE_PX) / 2,
        y: node.y + BADGE_INSET_PX,
        w: BADGE_SIZE_PX,
        h: BADGE_SIZE_PX,
      },
    },
  ]
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
  decorations: [stencilBadge],
  readShape: resolveNodeShape,
  readTextPlacement: resolveNodeTextAlign,
  // The same objects the plugin registers as assets, so the renderer's
  // table and the registry's cannot disagree about what `visual.sketch` is.
  themes: VISUAL_THEMES,
  readTheme: resolveCanvasTheme,
}
