/**
 * How much room a legend takes, shared by the SVG backend that draws it and
 * the envelope that makes room for it — one estimate, so a document's band
 * and its panel can never disagree. Estimated rather than measured: the
 * backend has no measurer and a legend's words are short identifiers, so a
 * generous glyph width keeps a long value inside the panel.
 */
import type { SceneLegend } from '@kamiazya/whiteboard-scene'

export const LEGEND_MARGIN_PX = 12
export const LEGEND_PAD_PX = 8
export const LEGEND_ROW_PX = 18
export const LEGEND_FONT_PX = 12
/** Roboto at 12px averages ~6.2px a glyph; 7 keeps a long value inside the panel. */
const GLYPH_PX = 7
export const LEGEND_SWATCH_W = 16
export const LEGEND_SWATCH_H = 11
export const LEGEND_GAP_PX = 6

export const UNTAGGED_LABEL = 'untagged'
export const legendValueLabel = (value: string): string => (value === '' ? UNTAGGED_LABEL : value)

export interface LegendRow {
  readonly text: string
  readonly muted?: true
  readonly key?: true
}

/** The panel's lines in order: each key, its values, then the muted notes. */
export function legendRows(legend: SceneLegend): LegendRow[] {
  const out: LegendRow[] = []
  for (const key of legend.keys) {
    out.push({ text: key.key, key: true })
    for (const entry of key.entries) out.push({ text: legendValueLabel(entry.value) })
  }
  if (legend.uncarried.boxes) out.push({ text: 'box colour: no key carries it', muted: true })
  if (legend.uncarried.edges) out.push({ text: 'edge colour: no key carries it', muted: true })
  return out
}

/** The panel's own box, margin excluded; `{ w: 0, h: 0 }` for nothing to say. */
export function legendPanelSize(legend: SceneLegend): { readonly w: number; readonly h: number } {
  const rows = legendRows(legend)
  if (rows.length === 0) return { w: 0, h: 0 }
  const widest = Math.max(...rows.map((row) => row.text.length)) * GLYPH_PX
  return {
    w: LEGEND_PAD_PX * 2 + LEGEND_SWATCH_W + LEGEND_GAP_PX + widest,
    h: LEGEND_PAD_PX * 2 + rows.length * LEGEND_ROW_PX,
  }
}
