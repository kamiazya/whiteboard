/**
 * The host's design tokens as this package's inline styles spell them.
 *
 * A workspace package cannot ship class names, so each value is a custom
 * property the host defines with the literal a bare page falls back to. They
 * live here once: four files spelled the same palette each, and a fallback
 * edited in one left the others to disagree on a page with no host.
 */
export const INK = 'var(--foreground, #171717)'
export const MUTED = 'var(--muted-foreground, #737373)'
export const LINE = 'var(--border, #e5e5e5)'
export const ACCENT = 'var(--accent, #f2f2f2)'
export const RING = 'var(--ring, #3b82f6)'
export const PRIMARY = 'var(--primary, #171717)'
export const DANGER = 'var(--destructive, #b3261e)'

/** The page's own surface. */
export const SURFACE = 'var(--background, #ffffff)'

/** A floating surface: the host's popover colour where it has one. */
export const POPOVER_SURFACE = 'var(--popover, var(--background, #ffffff))'
