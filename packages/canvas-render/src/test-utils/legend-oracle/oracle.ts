import type { SceneLegend } from '@kamiazya/whiteboard-scene'

/** Parts of a record this file no longer spells out: the recording holds them as JSON. */
type CanvasWire = unknown

/**
 * The shape of a frozen recording (ADR-0054 step 7, S18h): what the TypeScript answered before it was deleted. The Rust port replays the recording natively; nothing here answers it again.
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
