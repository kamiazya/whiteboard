/**
 * Breathing room the halo pill adds around a text run's box, in px. The
 * overhang is paint, so `sceneBounds` adds it to the run's reach: a derived
 * viewBox that ignored it clipped the top of a label sitting on the edge.
 * Lives in `theme/` because the backend that draws the pill and the bounds
 * that must contain it both read it.
 */
export const TEXT_HALO_PAD_PX = 2
