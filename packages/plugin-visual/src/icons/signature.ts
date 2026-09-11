/**
 * The product's signature squiggle, as registered icon geometry.
 *
 * `visual.theme/v0`'s picker draws its options as this ONE mark, once per
 * theme, each rendered in that theme's own ink — so the row says "the
 * whiteboard, drawn this way". A node would have been the obvious specimen
 * and is the wrong one: a rounded rectangle at 16px shows a theme's corner
 * radius and nothing else, while the difference a person is choosing is how
 * a LINE is put down (pencil, or a lit trace).
 *
 * Path copied verbatim from `apps/web/BRAND.md`, which governs it: "Every
 * brand surface renders this exact path", in an 88x56 box. It travels as an
 * ASSET rather than a component for the reason every glyph here does — the
 * registry is the road both realms already share.
 */
import type { LucideIconElement } from './icons.js'

/**
 * CROPPED to the mark plus room for a halo, not BRAND.md's 88x56 frame. The
 * path is the exact one that file governs; what changes is how much empty
 * board travels with it. At the 16px a picker option gives a glyph, the
 * standard frame spends nearly half its width on margin and the squiggle
 * comes out as a hairline — and a theme swatch nobody can read is a word
 * with extra steps.
 *
 * Bounds: the path spans x 20..68 and y 25..44 (the second curve's own
 * extremum, not its control point). Ten units of margin is what the glow
 * pass needs at its width without clipping.
 */
export const SIGNATURE_VIEWBOX = '10 15 68 39'

export const SIGNATURE_GEOMETRY: ReadonlyArray<LucideIconElement> = [
  { tag: 'path', d: 'M20 44 C 27 22, 37 22, 44 33 S 58 50, 68 25' },
]
