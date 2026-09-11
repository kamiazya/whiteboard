import {
  constantRatioMeasureText,
  SPATIAL_THEME_FONT_FAMILY,
} from '@kamiazya/whiteboard-canvas-render'
import type { SceneTextMeasurer, ServerDeps } from '../server-deps.js'

/**
 * What a server with no measurer of its own lays out with: a ratio that
 * matches no real font, answering for the bundled family alone — the one
 * the layout falls back to DECLARING, so nothing is ever declared that the
 * fallback did not also measure.
 */
const BUNDLED_TEXT_MEASURER: SceneTextMeasurer = {
  measure: constantRatioMeasureText,
  measurableFamilies: new Set([SPATIAL_THEME_FONT_FAMILY]),
}

/** The composition root's measurer, or the degraded one above. */
export async function resolveTextMeasurer(deps: ServerDeps): Promise<SceneTextMeasurer> {
  return (await deps.textMeasurer?.()) ?? BUNDLED_TEXT_MEASURER
}

/** The layout's `fontAvailable` seam, answered from the measurer and nowhere else. */
export function fontAvailableOf(measurer: SceneTextMeasurer): (family: string) => boolean {
  return (family) => measurer.measurableFamilies.has(family)
}
