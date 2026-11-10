import { visualStrokeFacetSchema } from './generated/visual.zod.js'

/**
 * The weights a stroke can be drawn at. `thin` is the weight every line has
 * always had, and it is the ABSENT facet — never a stored value — so a
 * board drawn before widths existed, and every line an import or an agent
 * wrote, keeps the weight it was drawn at. The same convention as
 * `visual.shape/v0`'s rect.
 */
export const STROKE_WIDTHS = ['thin', 'medium', 'thick'] as const

export type StrokeWidth = (typeof STROKE_WIDTHS)[number]

/**
 * `visual.stroke/v0` — how heavy a stroke is drawn.
 *
 * A facet rather than a field of the line: it says how a line DRAWS, which
 * is what this plugin is for, and it rides the facet bucket every projection
 * already carries, so a JSON Canvas or OCIF reader gets it the way it gets
 * the stroke's `curved` routing. Its own facet rather than a field of
 * `visual.ink/v0`, because that one is an identity that Group and Ungroup
 * write and remove whole — a weight stored there would be lost to an
 * Ungroup.
 *
 * Named weights rather than pixels: the renderer scales the THEME's line
 * weight by them, so a theme that draws heavier draws every weight heavier.
 */
export { visualStrokeFacetSchema }

export const VISUAL_STROKE_KEY = 'visual.stroke/v0'
