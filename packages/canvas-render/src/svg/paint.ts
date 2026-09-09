/**
 * Presence-only paint: the attribute helpers every SVG element here shares.
 * An absent or unusable field is omitted rather than defaulted — see the
 * `Appearance` doc comment for why the backend never invents a value — and
 * the shared definitions (the drop shadow) are declared per referencing
 * element and hoisted by `collectDefs`, so a scene without one stays
 * byte-identical.
 */
import type { Appearance, BoundingBox } from '../scene-graph.js'
import type { PaintAttrs, SvgBoxAttrs } from './elements.js'
import { formatCoord } from './format.js'
import { el, type SvgDef } from './vnode.js'

/**
 * Decorative/presentational elements (backgrounds, dividers, group
 * wrappers) that carry no independently-meaningful semantics get
 * `role="presentation"` so a screen reader does not announce them; text
 * runs and links keep their natural implicit role.
 */
export const PRESENTATION = 'presentation'

export function rectAttrs(bbox: BoundingBox): SvgBoxAttrs {
  // Fixed declaration order: x, y, width, height.
  return { x: bbox.x, y: bbox.y, width: bbox.w, height: bbox.h }
}

export function isFiniteBox(box: BoundingBox): boolean {
  return [box.x, box.y, box.w, box.h].every(Number.isFinite)
}

export function isNonEmptyString(value: string | undefined): value is string {
  return typeof value === 'string' && value.length > 0
}

/** Non-finite or negative is dropped; zero is a legitimate stroke-width/font-size. */
export function isNonNegativeLength(value: number | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

/** SVG treats a negative `rx` as an error and `rx="0"` is noise, so both are omitted. */
export function isPositiveLength(value: number | undefined): value is number {
  return isNonNegativeLength(value) && value > 0
}

/**
 * Presence-only presentation attributes for a shape/text-run/edge, in the
 * fixed order `fill stroke stroke-width font-family font-size`. An absent
 * or unusable field is omitted rather than defaulted — see the
 * `Appearance` doc comment for why the backend never invents a value.
 */
export function appearanceAttrs(appearance?: Appearance): PaintAttrs {
  if (!appearance) return {}
  const attrs: PaintAttrs = {}
  if (isNonEmptyString(appearance.fill)) attrs.fill = appearance.fill
  if (isNonEmptyString(appearance.stroke)) attrs.stroke = appearance.stroke
  if (isNonNegativeLength(appearance.strokeWidth)) attrs['stroke-width'] = appearance.strokeWidth
  if (isNonEmptyString(appearance.fontFamily)) attrs['font-family'] = appearance.fontFamily
  if (isNonNegativeLength(appearance.fontSize)) attrs['font-size'] = appearance.fontSize
  // Emitted after `fill` so the pair reads together; `1` is the SVG initial
  // value, so it is omitted to keep an opacity-free scene byte-identical.
  if (
    typeof appearance.fillOpacity === 'number' &&
    Number.isFinite(appearance.fillOpacity) &&
    appearance.fillOpacity !== 1
  ) {
    attrs['fill-opacity'] = appearance.fillOpacity
  }
  if (
    typeof appearance.strokeOpacity === 'number' &&
    Number.isFinite(appearance.strokeOpacity) &&
    appearance.strokeOpacity !== 1
  ) {
    attrs['stroke-opacity'] = appearance.strokeOpacity
  }
  if (isNonEmptyString(appearance.strokeDasharray)) {
    attrs['stroke-dasharray'] = appearance.strokeDasharray
  }
  return attrs
}

export function pointsAttr(
  points: ReadonlyArray<{ readonly x: number; readonly y: number }>,
): string {
  return points.map((p) => `${formatCoord(p.x)},${formatCoord(p.y)}`).join(' ')
}

/**
 * Content-derived id token: every character outside [A-Za-z0-9-] becomes
 * `_` + its hex code point, so any authored color string yields a valid,
 * collision-free XML id and the same color always derives the same id
 * (which is what lets `collectDefs` share one definition per color).
 */
export function idToken(value: string): string {
  return [...value]
    .map((ch) => (/[A-Za-z0-9-]/.test(ch) ? ch : `_${(ch.codePointAt(0) ?? 0).toString(16)}`))
    .join('')
}

export const DROP_SHADOW_ID = 'wb-drop-shadow'

/**
 * One shared soft shadow for everything that floats (the comment layer's
 * chrome). Declared per referencing element and hoisted by `collectDefs`,
 * exactly like the fade mask, so a shadow-free scene stays byte-identical.
 * The region is widened past the default -10%..110% because the blur's
 * reach (3·stdDeviation + dy ≈ 5.5px) exceeds 10% of a small element like
 * the 20px pin, and a clipped shadow reads as a rendering artifact.
 */
export const DROP_SHADOW_DEFS: ReadonlyArray<SvgDef> = [
  {
    id: DROP_SHADOW_ID,
    node: el(
      'filter',
      { id: DROP_SHADOW_ID, x: '-30%', y: '-30%', width: '160%', height: '160%' },
      [
        el('feDropShadow', {
          dx: 0,
          dy: 1,
          stdDeviation: 1.5,
          'flood-color': '#000000',
          'flood-opacity': 0.3,
        }),
      ],
    ),
  },
]
