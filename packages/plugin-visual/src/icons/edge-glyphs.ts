/**
 * The geometry `visual.edges/v0`'s own picker draws with: one specimen per
 * routing style, and one per line-jump setting.
 *
 * Drawn rather than vendored because lucide has no glyph for any of them —
 * and because these are pictures of what THIS facet does, so the plugin
 * that owns the vocabulary owns the drawing of it. They travel as registered
 * icon assets (ADR-0013 decision 3), which is what lets a declared picker
 * name them without this package shipping a component.
 *
 * The lucide 24-grid and its stroke conventions, so a row of these sits
 * beside the vendored icons without reading as a second set. Each routing
 * specimen runs the same corner-to-corner span and differs only in HOW it
 * gets there, which is the one thing the option is choosing; a specimen
 * that also changed length would put a difference in the picture that the
 * setting does not have.
 */
import type { LucideIconElement } from './icons.js'

/** Both jump specimens: the crossed line the hop is or is not taken over. */
const CROSSED = { tag: 'path', d: 'M12 4 V20' } as const

export const EDGE_GLYPHS: Readonly<Record<string, ReadonlyArray<LucideIconElement>>> = {
  'edge-straight': [{ tag: 'path', d: 'M4 20 L20 4' }],
  'edge-orthogonal': [{ tag: 'path', d: 'M4 20 H12 V4 H20' }],
  'edge-curved': [{ tag: 'path', d: 'M4 20 C 10 20, 14 4, 20 4' }],
  // Flat through the crossing: the two lines simply meet.
  'line-jumps-off': [CROSSED, { tag: 'path', d: 'M4 12 H20' }],
  // The same pair with the horizontal hopping over — the arc is the whole
  // difference, so it is the only thing that moves between the two.
  'line-jumps-on': [CROSSED, { tag: 'path', d: 'M4 12 H9 A3 3 0 0 1 15 12 H20' }],
}
