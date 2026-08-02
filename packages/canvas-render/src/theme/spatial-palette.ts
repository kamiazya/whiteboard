// The color half of the spatial theme layer (package-canvas-render.md
// decision #8). Node fill is differentiated per kind (absorbing the export
// composition root's prior per-type tinting, a real semantic worth keeping
// on every surface); stroke/edge/label colors are each ONE accessible value
// per mode so the WCAG contrast guarantee the editor already relied on
// (editor-appearance-contrast.test.ts) survives unifying into one producer.
export interface SpatialNodeStyle {
  readonly fill: string
  readonly stroke: string
}

export interface SpatialPalette {
  readonly node: Readonly<Record<'text' | 'file' | 'link' | 'group', SpatialNodeStyle>>
  /** Stroke applied to a routed edge when it carries no authored color. */
  readonly edgeStroke: string
  /** Fill applied to every label run (node labels and edge labels). */
  readonly labelFill: string
  /** Uniform corner radius (px) applied to every node's chrome shape. */
  readonly cornerRadiusPx: number
}

// Seeded from the pre-theme export composition root's chrome (per-type
// fill/stroke) plus the pre-theme editor's accessible `#333333` text/stroke
// — this is what lets a single stroke/label value keep clearing the WCAG
// floors the editor already tested for, while node fill still
// differentiates by kind the way export's chrome did.
export const SPATIAL_LIGHT_PALETTE: SpatialPalette = {
  node: {
    text: { fill: '#ffffff', stroke: '#333333' },
    file: { fill: '#f5f5f5', stroke: '#333333' },
    link: { fill: '#eef4ff', stroke: '#333333' },
    // Groups stay unfilled: a filled group rect emitted in document order
    // alongside a member node would otherwise risk painting over/under it
    // depending on emission order.
    group: { fill: 'none', stroke: '#333333' },
  },
  edgeStroke: '#333333',
  labelFill: '#333333',
  cornerRadiusPx: 4,
}

// Seeded from the pre-theme editor's dark palette (EDITOR_DARK_PALETTE) — a
// desaturated cool gray/near-white pair chosen to read against the app's
// dark canvas surface (`oklch(0.145 0 0)`), not `#333333` inverted. Node
// fill stays `none` in dark mode: export does not render a dark-mode
// variant today (`headless-renderer`'s `theme: 'dark'` only changes the
// document background), so there is no per-type dark fill to converge
// against yet — filed as follow-up, not invented here.
export const SPATIAL_DARK_PALETTE: SpatialPalette = {
  node: {
    text: { fill: 'none', stroke: '#9BA3AF' },
    file: { fill: 'none', stroke: '#9BA3AF' },
    link: { fill: 'none', stroke: '#9BA3AF' },
    group: { fill: 'none', stroke: '#9BA3AF' },
  },
  edgeStroke: '#9BA3AF',
  labelFill: '#E6E8EB',
  cornerRadiusPx: 4,
}
