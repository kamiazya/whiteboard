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

// Quiet-tool direction (apps/web/DESIGN.md): node and edge strokes sit at
// a mid neutral instead of near-black so chrome recedes and content reads
// first, while clearing the WCAG 1.4.11 non-text floor (#737373 vs white =
// 4.74:1); labels stay comfortably past the 1.4.3 text floor (#404040 =
// 10.4:1). Node fill still differentiates by kind — a real semantic worth
// keeping on every surface — and one stroke/label value per mode is what
// keeps the WCAG guarantee testable as a single producer.
export const SPATIAL_LIGHT_PALETTE: SpatialPalette = {
  node: {
    text: { fill: '#ffffff', stroke: '#737373' },
    file: { fill: '#f5f5f5', stroke: '#737373' },
    link: { fill: '#eef4ff', stroke: '#737373' },
    // Groups stay unfilled: a filled group rect emitted in document order
    // alongside a member node would otherwise risk painting over/under it
    // depending on emission order.
    group: { fill: 'none', stroke: '#737373' },
  },
  edgeStroke: '#737373',
  labelFill: '#404040',
  cornerRadiusPx: 6,
}

// Seeded from the pre-theme editor's dark palette (EDITOR_DARK_PALETTE) — a
// desaturated cool gray/near-white pair chosen to read against the app's
// dark canvas surface (`oklch(0.145 0 0)`), not `#333333` inverted. Node
// fill stays `none` in dark mode: nodes read as outlined shapes on the
// dark surface (the editor's behavior), and export's dark variant keeps
// body text legible via the document-level root `fill` seam
// (SvgDocumentOptions.textFill) rather than per-node fills.
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
