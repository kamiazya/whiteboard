import type {
  FacetGlyph,
  FacetGlyphShape,
  FacetRegistry,
  IconAsset,
} from '@kamiazya/whiteboard-facet-engine'
import { Ban, Circle, Cylinder, Diamond, Hexagon, Square } from 'lucide-react'
import { createElement, type ReactNode } from 'react'

/**
 * The core's glyph vocabulary rendered: a spec NAMES a glyph, this draws it.
 * Keeping the map in the vessel (not the engine) is the same split as
 * everywhere else — the engine owns what may be said, the vessel owns how it
 * looks.
 *
 * It lives in its own module because every vessel draws it. A picker showing
 * shapes in one and words in the other is two vocabularies pretending to be
 * one.
 */
function shapeGlyph(name: FacetGlyphShape): ReactNode {
  switch (name) {
    // 'none' is a real member of the vocabulary — the "no value" option —
    // and gets the slash a reader already reads as "not this".
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

/**
 * A registered icon asset, drawn from the GEOMETRY the registry holds
 * (ADR-0013 decision 3) rather than from a component the plugin shipped.
 *
 * That is the whole reason a plugin's own icons can reach a declared
 * picker at all: geometry is data, so it crosses the same road a theme's
 * tokens cross, and every realm that has the registry can draw it — the
 * picker here, the canvas renderer, an export with no DOM. A component
 * could only ever have drawn in one of them.
 *
 * Answers undefined for an id this build does not carry. A stored id
 * another deployment registered is data, not an error (the write path
 * checks it; the read path never does), so the caller decides what to
 * show instead.
 */
function geometryOf(asset: IconAsset, keyPrefix: string): readonly ReactNode[] {
  return asset.geometry.map((element, index) => {
    const { tag, ...attrs } = element
    // Registered geometry is a fixed, never-reordered list, so the index is
    // a stable identity here.
    return createElement(tag, { ...attrs, key: `${keyPrefix}-${tag}-${index}` })
  })
}

function assetGlyph(id: string, registry: FacetRegistry | undefined): ReactNode | undefined {
  const asset = registry?.iconAsset(id)
  if (asset === undefined) return undefined
  return (
    <svg
      viewBox={asset.viewBox ?? '0 0 24 24'}
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {geometryOf(asset, 'ink')}
    </svg>
  )
}

/**
 * Registered geometry drawn the way a registered THEME draws it.
 *
 * Only the two token families a person can see at this size, and each maps
 * to the gesture the renderer itself makes rather than to a second
 * invention:
 *
 * - `ink: 'sketch'` — the renderer lays a jittered second pass over the
 *   first, so the swatch does too: one nudged, lightened copy. At 16px a
 *   seeded per-point jitter is invisible; a visible doubling is what the
 *   hand actually looks like from across the panel.
 * - `glow` — the renderer haloes every stroke in its own colour, so the
 *   swatch lays a wider, faint copy underneath. A real blur filter is the
 *   renderer's answer at canvas scale and disappears at this one.
 *
 * COLOUR is deliberately not taken from the theme's palette. A theme
 * carries both mode palettes and the canvas surface follows the UI, not the
 * theme — so a swatch would have to know which mode the panel is in to pick
 * honestly, and a swatch drawn in the wrong half is worse than one drawn in
 * none. `currentColor` inherits the panel's own ink, which leaves exactly
 * the difference the option is choosing: how the line is put down.
 */
function themeGlyph(
  themeId: string,
  iconId: string,
  registry: FacetRegistry | undefined,
): ReactNode | undefined {
  const asset = registry?.iconAsset(iconId)
  const theme = registry?.themeAsset(themeId)
  if (asset === undefined || theme === undefined) return undefined
  return (
    <svg
      viewBox={asset.viewBox ?? '0 0 24 24'}
      fill="none"
      stroke="currentColor"
      strokeWidth="9"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {theme.glow !== undefined && (
        <g strokeWidth="22" strokeOpacity={0.3}>
          {geometryOf(asset, 'glow')}
        </g>
      )}
      {geometryOf(asset, 'ink')}
      {theme.ink === 'sketch' && (
        <g transform="translate(6 -5)" strokeOpacity={0.55}>
          {geometryOf(asset, 'second-pass')}
        </g>
      )}
    </svg>
  )
}

/**
 * @param registry needed only by the `asset` arm — a caller with no
 * registry simply draws no asset glyphs, which is the same degradation as
 * an unknown id.
 */
export function glyphIcon(glyph?: FacetGlyph, registry?: FacetRegistry): ReactNode | undefined {
  if (glyph === undefined) return undefined
  if (glyph.kind === 'shape') return shapeGlyph(glyph.name)
  if (glyph.kind === 'char') return glyph.value
  if (glyph.kind === 'theme') return themeGlyph(glyph.id, glyph.icon, registry)
  return assetGlyph(glyph.id, registry)
}
