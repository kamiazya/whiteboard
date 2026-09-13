import type {
  FacetGlyph,
  FacetGlyphShape,
  FacetRegistry,
  IconAsset,
} from '@kamiazya/whiteboard-facet-engine'
import { Ban, Circle, Cylinder, Diamond, Hexagon, Octagon, Square } from 'lucide-react'
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
/**
 * An SVG with no `width`/`height` has an intrinsic size of 300x150, and it
 * only sits inside its 16px box here because the box is a flex container and
 * the default `flex-shrink` pulls it back. That is a load-bearing accident:
 * a caller that drops the glyph anywhere but a shrinking flex line gets a
 * 300px drawing. The lucide components this module also returns carry their
 * own dimensions, so declaring these makes the two kinds behave alike.
 *
 * Percentages rather than a fixed size, so the ONE place that decides how
 * big a glyph is stays `option-group.tsx`'s box.
 */
const GLYPH_SVG_SIZE = { width: '100%', height: '100%' } as const

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
    case 'octagon':
      return <Octagon />
    case 'parallelogram':
      // No lucide glyph for a parallelogram; drawn in the same 24-grid
      // stroke style so a row of these reads as one set.
      return (
        <svg
          {...GLYPH_SVG_SIZE}
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
      {...GLYPH_SVG_SIZE}
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
      {...GLYPH_SVG_SIZE}
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
 * The faces that draw an emoji IN COLOUR, named explicitly because the
 * fallback does not.
 *
 * An emoji left to the inherited UI stack is drawn by whichever installed
 * font claims its codepoint first, and several ordinary text faces claim
 * the common ones as MONOCHROME OUTLINES. Measured in this repo's own
 * headless Chromium: `fc-match sans-serif` answers DejaVu Sans, which
 * covers U+1F600 and friends, so 😀 😃 🙂 😉 ☺️ ♠️ 🏁 came out as grey
 * line drawings while 🤣 🥰 ⭐ 🔥 — codepoints DejaVu lacks — fell through
 * to Noto Color Emoji and came out in colour. One grid, two kinds of
 * picture, and nothing in the data to explain it.
 *
 * It is not only this container: the same split happens on any machine
 * whose UI font covers part of the emoji block, and which part depends on
 * the machine. Naming the colour faces is what makes the answer the same
 * everywhere one exists.
 *
 * Four faces and then the generic: macOS/iOS, Windows, Linux/Android/
 * ChromeOS, and Firefox's own bundle. `Segoe UI Symbol` is deliberately
 * absent — it is Windows's MONOCHROME emoji face, and listing it is how a
 * stack meant to force colour quietly reintroduces the outlines.
 */
export const EMOJI_FONT_STACK =
  '"Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", "Twemoji Mozilla", sans-serif'

/**
 * One character, drawn by a font that has it in colour.
 *
 * Exported because every surface that draws a stored emoji needs it and
 * they are in different packages — the picker's cells here, a node's mark
 * on the minimap through `plugin-visual`'s `SymbolMark`. Two copies of a
 * font stack is two places for it to drift.
 */
export function EmojiText({ value }: { readonly value: string }): ReactNode {
  return <span style={{ fontFamily: EMOJI_FONT_STACK }}>{value}</span>
}

/**
 * @param registry needed only by the `asset` arm — a caller with no
 * registry simply draws no asset glyphs, which is the same degradation as
 * an unknown id.
 */
export function glyphIcon(glyph?: FacetGlyph, registry?: FacetRegistry): ReactNode | undefined {
  if (glyph === undefined) return undefined
  if (glyph.kind === 'shape') return shapeGlyph(glyph.name)
  if (glyph.kind === 'char') return <EmojiText value={glyph.value} />
  if (glyph.kind === 'theme') return themeGlyph(glyph.id, glyph.icon, registry)
  return assetGlyph(glyph.id, registry)
}
