/**
 * The quality instruments, published as their own subpath
 * (`@kamiazya/whiteboard-canvas-render/scoring`) and not from the main barrel.
 *
 * What reads them is the tool-surface eval lane and this package's own
 * scoreboards; nothing the layout worker, the editor or the daemon runs does.
 * See `scoring-subpath.test.ts` for the pin.
 */
export type { CompositionScore } from './quality/composition-score.js'
export { scoreComposition } from './quality/composition-score.js'
export type { DrawingScore } from './quality/drawing-score.js'
export {
  EVEN_GAP_TOLERANCE_PX,
  FRAME_CLEARANCE_FLOOR_PX,
  NEAR_MISS_PX,
  scoreDrawing,
} from './quality/drawing-score.js'
export type { FacetScore, MultiKey } from './quality/facet-score.js'
export { scoreFacets } from './quality/facet-score.js'
