/**
 * The legend as document chrome ([ADR-0040](../../../../docs/contributing/adr/0040-scoped-tags.md)
 * decision 6): drawn in the top-left corner of an EXPORTED document's
 * viewBox, over the content, so a reader of an SVG or a PNG sees what the
 * colour means without a panel. The editor draws the same `SceneLegend`
 * as its own overlay and asks this backend to omit it.
 *
 * Sized by an estimate rather than a measurer — the backend has none, and
 * a legend's words are short identifiers — at a fixed 12px sans face, so
 * the panel is a few pixels generous rather than clipping a long value.
 */
import type { BoundingBox, LegendKey, SceneLegend } from '@kamiazya/whiteboard-scene'
import {
  LEGEND_FONT_PX,
  LEGEND_GAP_PX,
  LEGEND_MARGIN_PX,
  LEGEND_PAD_PX,
  LEGEND_ROW_PX,
  LEGEND_SWATCH_H,
  LEGEND_SWATCH_W,
  legendPanelSize,
  legendRows,
  legendValueLabel,
} from '../legend/legend-geometry.js'
import { el, type SvgChild } from './vnode.js'

const MARGIN_PX = LEGEND_MARGIN_PX
const PAD_PX = LEGEND_PAD_PX
const ROW_PX = LEGEND_ROW_PX
const FONT_PX = LEGEND_FONT_PX
const SWATCH_W = LEGEND_SWATCH_W
const SWATCH_H = LEGEND_SWATCH_H
const GAP_PX = LEGEND_GAP_PX
const FONT = 'sans-serif'
const PANEL_FILL = '#ffffff'
const PANEL_STROKE = '#d4d4d4'
const INK = '#303030'
const MUTED = '#8a8a8a'
const valueLabel = legendValueLabel
const rows = legendRows

function swatch(key: LegendKey, entry: LegendKey['entries'][number], y: number): SvgChild {
  if (key.of === 'edges') {
    return el('line', {
      x1: 0,
      y1: y + SWATCH_H / 2,
      x2: SWATCH_W,
      y2: y + SWATCH_H / 2,
      stroke: entry.swatch.stroke ?? INK,
      'stroke-width': 2,
    })
  }
  return el('rect', {
    x: 0.5,
    y: y + 0.5,
    width: SWATCH_W - 1,
    height: SWATCH_H - 1,
    rx: 2,
    fill: entry.swatch.fill ?? 'none',
    stroke: entry.swatch.stroke ?? INK,
    'stroke-width': 1,
  })
}

export function renderLegend(legend: SceneLegend, viewBox: BoundingBox): SvgChild {
  const lines = rows(legend)
  if (lines.length === 0) return []
  const { w: width, h: height } = legendPanelSize(legend)
  const children: SvgChild[] = [
    el('rect', {
      x: 0,
      y: 0,
      width,
      height,
      rx: 4,
      fill: PANEL_FILL,
      stroke: PANEL_STROKE,
      'stroke-width': 1,
    }),
  ]
  let row = 0
  for (const key of legend.keys) {
    const keyY = PAD_PX + row * ROW_PX
    children.push(
      el(
        'text',
        {
          x: PAD_PX,
          y: keyY + FONT_PX,
          fill: INK,
          'font-family': FONT,
          'font-size': FONT_PX,
          'font-weight': 'bold',
        },
        [key.key],
      ),
    )
    row++
    for (const entry of key.entries) {
      const y = PAD_PX + row * ROW_PX
      children.push(
        el('g', { transform: `translate(${PAD_PX} ${y + (ROW_PX - SWATCH_H) / 2})` }, [
          swatch(key, entry, 0),
        ]),
        el(
          'text',
          {
            x: PAD_PX + SWATCH_W + GAP_PX,
            y: y + FONT_PX,
            fill: INK,
            'font-family': FONT,
            'font-size': FONT_PX,
          },
          [valueLabel(entry.value)],
        ),
      )
      row++
    }
  }
  for (const line of lines.filter((l) => l.muted)) {
    const y = PAD_PX + row * ROW_PX
    children.push(
      el(
        'text',
        { x: PAD_PX, y: y + FONT_PX, fill: MUTED, 'font-family': FONT, 'font-size': FONT_PX },
        [line.text],
      ),
    )
    row++
  }
  return el(
    'g',
    {
      'data-wb-legend': '',
      transform: `translate(${viewBox.x + MARGIN_PX} ${viewBox.y + MARGIN_PX})`,
    },
    children,
  )
}
