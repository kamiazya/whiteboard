import type { SceneLegend } from '@kamiazya/whiteboard-scene'
import { canvasLegend } from '../../legend/canvas-legend.js'
import { scoreFacets } from '../../quality/facet-score.js'
import { createSpatialTheme } from '../../theme/spatial-theme.js'
import { hex, viaJson } from '../compose-canvas-oracle/oracle.js'
import { type CanvasWire, canvasWire } from '../compose-canvas-oracle/wire.js'
import { boards } from './corpus.js'

/**
 * The recorded answers of the board's legend (`canvasLegend`, ADR-0040
 * decision 6) and of the reading of the facet score it is derived from —
 * what the colour channel of the boxes and of the edges is doing, and which
 * declared distinctions carry it (`scoreFacets`'s `channels.colour` and
 * `edges.colour`). Each legend is recorded under the light and the dark
 * theme, whose swatches differ.
 */

interface Reading {
  readonly use: 'carried' | 'contested' | 'unused'
  readonly carriedBy: readonly string[]
}

export interface CanvasLegendRecord {
  readonly name: string
  readonly canvas: CanvasWire
  readonly boxes: Reading
  readonly edges: Reading
  readonly light: SceneLegend | null
  readonly dark: SceneLegend | null
}

const LIGHT = createSpatialTheme({ mode: 'light' })
const DARK = createSpatialTheme({ mode: 'dark' })

const reading = ({ use, carriedBy }: Reading): Reading => ({ use, carriedBy: [...carriedBy] })

/** Every record, one per board. */
export function canvasLegendRecords(): readonly CanvasLegendRecord[] {
  return boards().map(({ name, canvas }) => {
    const score = scoreFacets(canvas)
    return {
      name,
      canvas: canvasWire(canvas, hex),
      boxes: reading(score.channels.colour),
      edges: reading(score.edges.colour),
      light: viaJson(canvasLegend(canvas, LIGHT) ?? null),
      dark: viaJson(canvasLegend(canvas, DARK) ?? null),
    }
  })
}
