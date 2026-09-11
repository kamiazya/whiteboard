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

export const SIGNATURE_VIEWBOX = '0 0 88 56'

export const SIGNATURE_GEOMETRY: ReadonlyArray<LucideIconElement> = [
  { tag: 'path', d: 'M20 44 C 27 22, 37 22, 44 33 S 58 50, 68 25' },
]
