/**
 * Glow's one number (ADR-0030 decision 8): how far a halo of a given radius
 * reaches past the element it surrounds. The backend blurs with a standard
 * deviation of half the radius, and a Gaussian is visually spent at three
 * deviations — so the reach is 1.5 radii, rounded up to whole pixels. It is
 * declared here, beside the sketch reach, because `sceneBounds` adds it for
 * a glowing node (a derived viewBox must never clip a halo) and the backend
 * sizes the filter region from those same bounds: one constant, two readers.
 */
export const GLOW_STD_DEVIATION_RATIO = 0.5

export function glowReachPx(radiusPx: number): number {
  if (!Number.isFinite(radiusPx) || radiusPx <= 0) return 0
  return Math.ceil(radiusPx * GLOW_STD_DEVIATION_RATIO * 3)
}
