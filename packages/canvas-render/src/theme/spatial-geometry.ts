// The geometry half of the spatial theme layer (package-canvas-render.md
// decision #8). Geometry is deliberately NOT part of a
// `SpatialAppearanceResolver` (see spatial-appearance.ts) — it drives
// wrapped-line counts and node content bounds, so a surface silently
// choosing its own value here (as the pre-theme editor/viewer/export
// resolvers each did) makes the same canvas lay out differently depending
// on who rendered it. `layoutSpatialCanvas` defaults to this constant and
// only accepts an override when a caller explicitly passes one.
export interface SpatialGeometry {
  /** Uniform padding (px) between a node's box edge and its laid-out content. */
  readonly paddingPx: number
  /** Font size (px) used for label runs (file/link/group labels, edge labels). */
  readonly labelFontSizePx: number
  /** Floor for a node's derived content width, so padding never drives it negative. */
  readonly minContentWidthPx: number
}

export const SPATIAL_THEME_GEOMETRY: SpatialGeometry = {
  paddingPx: 8,
  labelFontSizePx: 16,
  minContentWidthPx: 0,
}
