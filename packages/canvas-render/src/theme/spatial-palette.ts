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

/** JSON Canvas 1.0 numbered preset keys ('1' red … '6' purple). */
export type SpatialPresetKey = '1' | '2' | '3' | '4' | '5' | '6'

/**
 * One preset accent: the strong stroke and the quiet tint fill. The design
 * rule (apps/web/DESIGN.md): a preset colors a node's BORDER strongly and
 * its background as a tint — body text keeps the theme text color, so
 * readability never depends on the accent hue. Edges (and their J1
 * arrowheads) take `stroke` directly.
 */
export interface SpatialPresetAccent {
  readonly stroke: string
  readonly fill: string
}

/**
 * The fill for each syntax role inside a fenced code block. Drawn from the
 * SAME hues as the JSON Canvas preset accents, so code inside a node speaks
 * the colour language of the node borders around it and dark mode arrives
 * with the rest of the palette.
 *
 * The light values are one step darker than the matching preset stroke, and
 * that is not a stylistic tweak: preset strokes are floored at 3:1 against
 * the background because they are NON-TEXT (WCAG 1.4.11), while a syntax
 * token is text on the code surface and owes 4.5:1 (1.4.3). Measured on the
 * light surface, the 600-weight strokes came in at 3.15-3.33 — a floor the
 * dark ramp already cleared and the light one did not.
 *
 * The blue spark is deliberately absent, however conventional a blue keyword
 * is: BRAND.md reserves `#3b6ecc` for the AI acting, and "its meaning is the
 * point".
 */
export interface SpatialSyntaxPalette {
  readonly keyword: string
  readonly string: string
  readonly number: string
  readonly comment: string
}

export interface SpatialPalette {
  readonly node: Readonly<Record<'text' | 'file' | 'link' | 'group', SpatialNodeStyle>>
  /** Stroke applied to a routed edge when it carries no authored color. */
  readonly edgeStroke: string
  /** Fill applied to every label run (node labels and edge labels). */
  readonly labelFill: string
  /**
   * The canvas surface color this mode paints under everything — the label
   * halo color, and the export default background. Hex, not oklch: resvg
   * (PNG export) parses no oklch(); dark is the hex equivalent of the
   * app's `oklch(0.145 0 0)` surface.
   */
  readonly surface: string
  /** Uniform corner radius (px) applied to every node's chrome shape. */
  readonly cornerRadiusPx: number
  /**
   * The six JSON Canvas preset accents, PER MODE — swappable theme DATA,
   * never hardcoded in resolver code. Floors any replacement must keep
   * (pinned by spatial-theme.test.ts, as floors rather than exact values):
   * stroke >= 3:1 against the mode background (WCAG 1.4.11), labelFill
   * >= 4.5:1 against the tint fill (WCAG 1.4.3).
   */
  readonly presets: Readonly<Record<SpatialPresetKey, SpatialPresetAccent>>
  /** Fills for syntax-highlighted code runs. */
  readonly syntax: SpatialSyntaxPalette
  /**
   * The comment annotation layer's chrome (ADR-0024): the anchor pin and
   * the bubble behind the comment text. Amber on both modes — the one hue
   * the node presets reserve for warm emphasis — so a comment reads as
   * distinct from every content node at a glance.
   */
  readonly comment: { readonly pin: SpatialNodeStyle; readonly bubble: SpatialNodeStyle }
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
  surface: '#ffffff',
  cornerRadiusPx: 6,
  // Tailwind 600 strokes (3.2-5.4:1 on white) over 100 tints (body text
  // 8.5-9.3:1) — the same ramp as the app's approved state colors.
  presets: {
    '1': { stroke: '#dc2626', fill: '#fee2e2' },
    '2': { stroke: '#ea580c', fill: '#ffedd5' },
    '3': { stroke: '#d97706', fill: '#fef3c7' },
    '4': { stroke: '#059669', fill: '#d1fae5' },
    '5': { stroke: '#0891b2', fill: '#cffafe' },
    '6': { stroke: '#9333ea', fill: '#f3e8ff' },
  },
  // Tailwind 700 — the text-grade step of the preset hues above.
  syntax: {
    keyword: '#7e22ce',
    string: '#047857',
    number: '#c2410c',
    comment: '#5b6472',
  },
  // The preset-3 amber pair: stroke 4.5:1 on white, labelFill 9.3:1 on the
  // tint — the same contrast-tested ramp the presets pin.
  comment: {
    pin: { fill: '#d97706', stroke: '#b45309' },
    bubble: { fill: '#fef3c7', stroke: '#d97706' },
  },
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
  surface: '#0a0a0a',
  cornerRadiusPx: 4,
  // Tailwind 400 strokes (7.2-11.9:1 on the near-black canvas) over 950
  // tints (near-white body text 10.9-13.2:1).
  presets: {
    '1': { stroke: '#f87171', fill: '#450a0a' },
    '2': { stroke: '#fb923c', fill: '#431407' },
    '3': { stroke: '#fbbf24', fill: '#451a03' },
    '4': { stroke: '#34d399', fill: '#022c22' },
    '5': { stroke: '#22d3ee', fill: '#083344' },
    '6': { stroke: '#c084fc', fill: '#3b0764' },
  },
  // The 400 strokes unchanged: measured 5.7-9.2 on the dark code surface,
  // so the dark ramp already clears the text floor the light one needed a
  // darker step for.
  syntax: {
    keyword: '#c084fc',
    string: '#34d399',
    number: '#fb923c',
    comment: '#9ba3af',
  },
  // The preset-3 dark pair (Tailwind 400 over 950), same ramp as above.
  comment: {
    pin: { fill: '#fbbf24', stroke: '#f59e0b' },
    bubble: { fill: '#451a03', stroke: '#fbbf24' },
  },
}
