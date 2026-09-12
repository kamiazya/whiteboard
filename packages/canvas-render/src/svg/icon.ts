/**
 * Drawing a REGISTERED icon: the table, its fallbacks, and the one producer
 * of a `<use>` that references one.
 *
 * Split out of `backend.ts` when a text run gained the ability to paint an
 * icon, so the `icon` scene node and that run share a producer rather than
 * each emitting their own `<symbol>`. It also breaks the type cycle
 * `shapes.ts` had with `backend.ts`, which existed only because `IconTable`
 * was declared there.
 *
 * Deliberately free of `ResolveTables` and `glowOf`: a caller resolves the
 * glow and hands the result over, which keeps this module's imports one-way
 * and its job pure construction.
 */
import { type LucideIconElement, VISUAL_ICONS } from '@kamiazya/whiteboard-plugin-visual'
import type { Appearance, BoundingBox } from '@kamiazya/whiteboard-scene'
import { appearanceAttrs, idToken, isFiniteBox } from './paint.js'
import { el, type SvgChild, type SvgDef, withDefs } from './vnode.js'

/**
 * An icon set's paint, applied to the whole `<symbol>` definition so one def
 * serves every referencing node. Only the stroke COLOR is left to inherit
 * from each `<use>`.
 */
export type IconPaint = Readonly<Record<string, string | number>>

/**
 * One icon: its geometry plus the two things geometry is meaningless without.
 *
 * `viewBox` is the coordinate space the geometry is drawn in, and `paint` the
 * convention it is authored for. Both were hard-coded to the bundled set's
 * before this, so a contributed icon in any other space came out the wrong
 * size and clipped, and one wanting a fill came out invisible.
 */
export interface IconContribution {
  readonly geometry: ReadonlyArray<LucideIconElement>
  readonly viewBox?: string
  readonly paint?: IconPaint
}

export type IconTable = Readonly<Record<string, IconContribution>>

/**
 * What a set that declares neither gets. 24x24 stroke-only is what every icon
 * in this repo is authored for, so a table saying nothing still draws.
 */
const FALLBACK_ICON_VIEWBOX = '0 0 24 24'
const FALLBACK_ICON_PAINT: IconPaint = {
  fill: 'none',
  'stroke-width': 2,
  'stroke-linecap': 'round',
  'stroke-linejoin': 'round',
}

/**
 * `Array.isArray` and not a bare `!== undefined`: both tables are plain
 * objects, so a prototype-inherited name (`toString`) answers a function,
 * which must degrade like any unknown name rather than throw downstream.
 */
export function lookupIcon(
  name: string,
  icons: IconTable | undefined,
): IconContribution | undefined {
  const fromCaller = icons === undefined ? undefined : icons[name]
  const found = fromCaller ?? VISUAL_ICONS[name]
  return Array.isArray(found?.geometry) ? found : undefined
}

function renderIconElement(element: LucideIconElement): SvgChild {
  switch (element.tag) {
    case 'path':
      return el('path', { d: element.d })
    case 'rect':
      return el('rect', {
        x: element.x,
        y: element.y,
        width: element.width,
        height: element.height,
        rx: element.rx,
      })
    case 'circle':
      return el('circle', { cx: element.cx, cy: element.cy, r: element.r })
    case 'ellipse':
      return el('ellipse', { cx: element.cx, cy: element.cy, rx: element.rx, ry: element.ry })
  }
}

/**
 * The ONE producer of an icon reference, for the `icon` scene node and for a
 * text run that paints one alike.
 *
 * Not merely shared for tidiness: the set's paint and coordinate space live
 * ON the `<symbol>` definition (`IconContribution`), so a second emitter
 * would be a second place for a contributed set's viewBox and paint
 * convention to be got wrong — and the two would then disagree about the
 * same icon depending on where it appeared. `undefined` means the table
 * cannot draw this name, which is a caller's decision to make: a node
 * renders nothing, a run paints its text.
 *
 * `stroke` alone is assigned per reference, because that is the only paint
 * a `<use>` can push into the definition.
 */
export type IconGlow = { readonly filter?: string; readonly defs: ReadonlyArray<SvgDef> }

export function renderIconUse(
  name: string,
  bbox: BoundingBox,
  appearance: Appearance | undefined,
  icons: IconTable | undefined,
  glow: IconGlow,
  strokeFallback?: string,
): SvgChild | undefined {
  if (!isFiniteBox(bbox)) return undefined
  const contribution = lookupIcon(name, icons)
  if (contribution === undefined) return undefined
  const id = `wb-icon-${idToken(name)}`
  const def: SvgDef = {
    id,
    node: el('symbol', { id, viewBox: contribution.viewBox ?? FALLBACK_ICON_VIEWBOX }, [
      // The set's paint lives ON the definition; only the stroke COLOR
      // inherits from each referencing <use>, so one def serves every
      // color-assigned node.
      el(
        'g',
        contribution.paint ?? FALLBACK_ICON_PAINT,
        contribution.geometry.map(renderIconElement),
      ),
    ]),
  }
  const paint = appearanceAttrs(appearance)
  const use = el('use', {
    href: `#${id}`,
    x: bbox.x,
    y: bbox.y,
    width: bbox.w,
    height: bbox.h,
    stroke: paint.stroke ?? strokeFallback,
    'stroke-opacity': paint['stroke-opacity'],
    filter: glow.filter,
  })
  return withDefs(use, [def, ...glow.defs])
}
