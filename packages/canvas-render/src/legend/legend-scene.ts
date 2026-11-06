/**
 * The legend as SCENE NODES, for a board drawn inside something else — a
 * canvas embedded in a note. The top-level scene carries its legend as
 * `scene.legend`, which the SVG backend draws as document chrome in the
 * viewBox's corner; a note can embed several boards, each with a legend of
 * its own, so an embed's legend has to be ordinary content placed under its
 * board, where every surface that paints the note (preview, print, export)
 * draws it without knowing it is a legend.
 *
 * Drawn at its own size, never scaled with the miniature: the board is
 * shrunk to fit the column, and a legend shrunk with it is the unreadable
 * key it exists to replace. No panel of its own either — it sits inside the
 * embed's frame already — and its words take the board's label ink, so it
 * reads in the theme the board is drawn in.
 */
import type { Appearance, LegendKey, SceneLegend, SceneNode } from '@kamiazya/whiteboard-scene'
import {
  LEGEND_FONT_PX,
  LEGEND_GAP_PX,
  LEGEND_ROW_PX,
  LEGEND_SWATCH_H,
  LEGEND_SWATCH_W,
  legendRows,
  legendValueLabel,
} from './legend-geometry.js'

/** Same generous estimate as `legendPanelSize`: a key's words are short identifiers. */
const GLYPH_PX = 7
const EDGE_SWATCH_PX = 2
const MUTED_OPACITY = 0.6

export interface LegendBlock {
  readonly nodes: readonly SceneNode[]
  readonly w: number
  readonly h: number
}

function swatchNode(
  key: LegendKey,
  entry: LegendKey['entries'][number],
  x: number,
  rowY: number,
  ink: Appearance,
): SceneNode {
  const top = rowY + (LEGEND_ROW_PX - LEGEND_SWATCH_H) / 2
  if (key.of === 'edges') {
    return {
      kind: 'shape',
      bbox: {
        x,
        y: top + (LEGEND_SWATCH_H - EDGE_SWATCH_PX) / 2,
        w: LEGEND_SWATCH_W,
        h: EDGE_SWATCH_PX,
      },
      appearance: { fill: entry.swatch.stroke ?? ink.fill },
    }
  }
  return {
    kind: 'shape',
    bbox: { x, y: top, w: LEGEND_SWATCH_W, h: LEGEND_SWATCH_H },
    radius: 2,
    appearance: {
      fill: entry.swatch.fill ?? 'none',
      stroke: entry.swatch.stroke ?? ink.fill,
      strokeWidth: 1,
    },
  }
}

function textNode(
  text: string,
  x: number,
  rowY: number,
  ink: Appearance,
  extra: { readonly strong?: true; readonly muted?: true } = {},
): SceneNode {
  return {
    kind: 'textRun',
    bbox: { x, y: rowY, w: text.length * GLYPH_PX, h: LEGEND_ROW_PX },
    text,
    baseline: LEGEND_FONT_PX,
    ...(extra.strong === undefined ? {} : { strong: true }),
    // The label ink's colour and family only: a label's halo is a pill for
    // reading text over an edge, and here it would box every word.
    appearance: {
      ...(ink.fill === undefined ? {} : { fill: ink.fill }),
      ...(ink.fontFamily === undefined ? {} : { fontFamily: ink.fontFamily }),
      fontSize: LEGEND_FONT_PX,
      ...(extra.muted === undefined ? {} : { fillOpacity: MUTED_OPACITY }),
    },
  }
}

/**
 * The legend's rows from the origin down, for the caller to place, or
 * undefined when it has nothing to say — the caller then lays the board out
 * exactly as it would with no legend at all.
 */
export function legendSceneBlock(legend: SceneLegend, ink: Appearance): LegendBlock | undefined {
  const rows = legendRows(legend)
  if (rows.length === 0) return undefined
  const textX = LEGEND_SWATCH_W + LEGEND_GAP_PX
  const nodes: SceneNode[] = []
  let row = 0
  for (const key of legend.keys) {
    nodes.push(textNode(key.key, 0, row * LEGEND_ROW_PX, ink, { strong: true }))
    row++
    for (const entry of key.entries) {
      const rowY = row * LEGEND_ROW_PX
      nodes.push(swatchNode(key, entry, 0, rowY, ink))
      nodes.push(textNode(legendValueLabel(entry.value), textX, rowY, ink))
      row++
    }
  }
  for (const line of rows.filter((candidate) => candidate.muted)) {
    nodes.push(textNode(line.text, 0, row * LEGEND_ROW_PX, ink, { muted: true }))
    row++
  }
  const widest = Math.max(...rows.map((candidate) => candidate.text.length)) * GLYPH_PX
  return { nodes, w: LEGEND_SWATCH_W + LEGEND_GAP_PX + widest, h: rows.length * LEGEND_ROW_PX }
}
