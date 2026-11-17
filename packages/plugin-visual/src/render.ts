/**
 * What `visual` registers with the TypeScript renderer, as one ordinary
 * contribution: its silhouettes, which the SVG backend paints, and its theme
 * assets with the reader of the theme a canvas names, which an editor chrome
 * and an export resolve a palette from.
 *
 * It lives here, not in `canvas-render`, so the renderer knows nothing of a
 * plugin's business — what its silhouettes are and which facet selects one.
 *
 * The layout is the Rust core's: a node's shape, its text placement and the
 * badge a stencil-wearing box carries are read and drawn by this plugin's
 * Rust twin (`crates/core/plugin-visual`), so none of them is contributed
 * from here.
 *
 * The contract comes from `@kamiazya/whiteboard-scene`, which sits BELOW
 * both this package and the renderer, so there is no package cycle to hold
 * open and no guard to keep honest.
 */
import type { BoundingBox, RenderContribution, ShapeContribution } from '@kamiazya/whiteboard-scene'
import { resolveCanvasTheme, VISUAL_SHAPE_KEY } from './data.js'
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
  },
}

/**
 * The octagon's corner cut, off the SMALLER dimension so the shape survives
 * any proportion: a quarter of it is pronounced enough to read as a cut
 * corner and never large enough to make two cuts meet.
 */
const octagonCut = (box: BoundingBox): number => Math.min(box.w, box.h) / 4

/** This plugin's whole rendering contribution. */
export const visualRenderContribution: RenderContribution = {
  namespace: VISUAL_SHAPE_KEY.slice(0, VISUAL_SHAPE_KEY.indexOf('.')),
  shapes,
  // The same objects the plugin registers as assets, so the renderer's
  // table and the registry's cannot disagree about what `visual.sketch` is.
  themes: VISUAL_THEMES,
  readTheme: resolveCanvasTheme,
}
