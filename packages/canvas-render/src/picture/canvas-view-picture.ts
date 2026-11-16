import { z } from 'zod'
import { type HitPoint, topmostHit } from '../hit-boxes.js'

// What the MCP Apps widget is handed beside `canvas_view`'s result: the
// picture the daemon laid out, so the widget lays nothing out itself (ADR-0054
// step 7, owner decision q54). Declared here because this is the one package
// both ends reach — the widget may not import server-core — and reachable
// through its own subpath so the widget's bundle takes this module and none of
// the layout behind the package's root.

// The widget's display schemas, re-exported so the bundle reaches them without
// the package root.
export { type SpatialRenderStyle, spatialRenderStyleSchema } from '../layout/layout-options.js'
export { type ThemeFont, themeFontSchema } from '../theme/theme-font.js'

/**
 * Where the picture rides on the tool RESULT: `_meta`, which an MCP Apps host
 * hands the view with the rest of the result and which is no part of what a
 * model reads. `structuredContent` would put the SVG into the published output
 * schema, and the model would pay for markup it never looks at.
 */
export const CANVAS_VIEW_PICTURE_META_KEY = 'whiteboard/canvas-view-picture'

const hitRectSchema = z
  .object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() })
  .strict()

/**
 * One candidate for a click, in PAINT order (`hitBoxesOf`), so the last that
 * contains a point is the one drawn on top. `container` marks a frame, which
 * yields to any content node under the same point.
 */
const hitBoxSchema = z
  .object({ id: z.string(), container: z.boolean().optional(), box: hitRectSchema })
  .strict()

export const canvasViewPictureSchema = z
  .object({
    /** canvas-render's `renderSceneToSvg` output, envelope and paper included. */
    svg: z.string(),
    /** Every node's stored box, for the comment anchor's target. */
    boxes: z.array(hitBoxSchema),
  })
  .strict()

export type CanvasViewPicture = z.infer<typeof canvasViewPictureSchema>

/** The id of the node a click at `point` lands on, by the editor's own rule. */
export function pictureNodeAt(picture: CanvasViewPicture, point: HitPoint): string | undefined {
  return topmostHit(picture.boxes, point)
}
