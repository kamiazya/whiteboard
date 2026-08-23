import type { FacetGlyph } from '@kamiazya/whiteboard-facet-engine'
import { Ban, Circle, Cylinder, Diamond, Hexagon, Square } from 'lucide-react'
import type { ReactNode } from 'react'

/**
 * The core's glyph vocabulary rendered: a spec NAMES a glyph, this maps the
 * name to a drawing. Keeping the map in the vessel (not the engine) is the
 * same split as everywhere else — the engine owns what may be said, the vessel
 * owns how it looks.
 *
 * It lives in its own module because BOTH vessels draw it — the context-menu
 * quick band and the full facets panel. A picker showing shapes in one and
 * words in the other is two vocabularies pretending to be one.
 */
export function glyphIcon(glyph?: FacetGlyph): ReactNode | undefined {
  switch (glyph) {
    case undefined:
      return undefined
    // 'none' is a real member of the vocabulary — the "no value" segment —
    // and gets the same slash the hand-written symbol band uses for it.
    case 'none':
      return <Ban />
    case 'square':
      return <Square />
    case 'circle':
      return <Circle />
    case 'diamond':
      return <Diamond />
    case 'hexagon':
      return <Hexagon />
    case 'parallelogram':
      // No lucide glyph for a parallelogram; drawn in the same 24-grid
      // stroke style so a row of these reads as one set.
      return (
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M7 5h14l-4 14H3Z" />
        </svg>
      )
    case 'cylinder':
      return <Cylinder />
  }
}
