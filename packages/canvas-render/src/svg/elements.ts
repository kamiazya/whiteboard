/**
 * The element/attribute table of the SVG this backend actually emits —
 * deliberately NARROW, not a general SVG typing. Every element and every
 * attribute here exists because a renderer emits it; extending the output
 * vocabulary means extending this table, which is where the canonical-
 * serialization review happens. Type aliases (not interfaces) throughout,
 * so each shape stays assignable to the serializer's loose attr storage.
 *
 * Conventions encoded as types rather than review rules:
 * - Coordinates and lengths are `number` — the serializer routes them
 *   through `formatCoord`, so a pre-formatted (locale-dependent) string
 *   cannot reach the output.
 * - Presence-only: an optional attribute set to `undefined` is omitted.
 * - `<a href>` takes a `SafeHref` (sanitizeHref/trustedHref), never a raw
 *   string, so an executable scheme cannot bypass the sanitizer. `<image
 *   href>` stays a plain string by decision #9 (emitted verbatim: data:/
 *   blob:/app URLs the composition root already owns).
 * - Stroked line elements declare `fill` explicitly — SVG's initial black
 *   fill painting a wedge across a bent edge is the shipped defect this
 *   requirement pins.
 */

import type { SafeHref } from './format.js'

export type SvgRole = 'presentation'

export type SvgBoxAttrs = {
  x: number
  y: number
  width: number
  height: number
}

export type PaintAttrs = {
  fill?: string
  stroke?: string
  'stroke-width'?: number
  'font-family'?: string
  'font-size'?: number
  'fill-opacity'?: number
  'stroke-opacity'?: number
}

export type TextEmphasisAttrs = {
  'font-weight'?: string
  'font-style'?: string
  'text-decoration'?: string
}

export type SvgElements = {
  svg: {
    xmlns?: string
    x?: number
    y?: number
    width?: number
    height?: number
    viewBox?: string
    overflow?: 'visible'
    fill?: string
    role?: SvgRole
  }
  // data-wb-key is the keyed renderer's patch handle (svg/keyed.ts) —
  // emitted only in keyed mode, never by the plain document renderer.
  g: PaintAttrs & {
    transform?: string
    'stroke-linecap'?: 'round'
    'stroke-linejoin'?: 'round'
    role?: SvgRole
    'data-wb-key'?: string
  }
  rect: SvgBoxAttrs & PaintAttrs & { rx?: number; role?: SvgRole }
  // width/height appear on <text> only through the legacy codeBlock/rawHtml
  // box-placement path (rectAttrs spread); x/y are the baseline contract.
  // 'middle' is the only anchor emitted: body runs are left-anchored by
  // omission (the initial value), and only the glyph badge centers itself.
  text: PaintAttrs &
    TextEmphasisAttrs & {
      x: number
      y: number
      width?: number
      height?: number
      mask?: string
      'text-anchor'?: 'middle'
      'xml:space'?: 'preserve'
    }
  a: { href: SafeHref }
  polyline: PaintAttrs & {
    points: string
    fill: string
    'marker-start'?: string
    'marker-end'?: string
    role?: SvgRole
  }
  // `fill` became optional when outline silhouettes joined the path users
  // (presence-only paint like rect). EDGES must still declare fill="none"
  // explicitly — SVG's initial black fill paints a wedge across a bent
  // path — which their byte-level tests pin now that the type cannot.
  path: PaintAttrs & {
    d: string
    'marker-start'?: string
    'marker-end'?: string
    role?: SvgRole
  }
  // Outline polygons inherit paint presence-only like rect; marker content
  // keeps passing an explicit fill.
  polygon: PaintAttrs & { points: string; role?: SvgRole }
  ellipse: PaintAttrs & { cx: number; cy: number; rx: number; ry: number; role?: SvgRole }
  circle: PaintAttrs & { cx: number; cy: number; r: number; role?: SvgRole }
  symbol: { id: string; viewBox: string }
  // `href` is a package-composed fragment reference (`#wb-icon-…`), not a
  // navigation target, so it stays a plain string rather than SafeHref.
  use: PaintAttrs & { href: string; x: number; y: number; width: number; height: number }
  marker: {
    id: string
    markerWidth: number
    markerHeight: number
    refX: number
    refY: number
    markerUnits: 'userSpaceOnUse'
    orient: 'auto'
  }
  image: SvgBoxAttrs & { href: string; preserveAspectRatio: string; role?: SvgRole }
  title: Record<string, never>
  defs: Record<string, never>
  linearGradient: { id: string; x1?: number; y1?: number; x2?: number; y2?: number }
  stop: { offset: number; 'stop-color': string }
  mask: { id: string; maskContentUnits?: 'objectBoundingBox' }
}

export type SvgTagName = keyof SvgElements
