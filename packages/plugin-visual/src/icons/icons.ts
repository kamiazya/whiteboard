/**
 * Vendored lucide icon geometry (see README.md for provenance, license and
 * the extend-me recipe), held in `../assets/icons-lucide.json`. Each icon is
 * a list of primitive elements in the 24x24 lucide viewBox; paint is
 * deliberately absent — the SVG backend wraps them in a stroke-styled group
 * and the referencing `<use>` assigns the color, so the table stays pure
 * geometry.
 */
import { type IconAsset, iconAssetSchema } from '@kamiazya/whiteboard-facet-engine'
import { assetTable } from '../asset-table.js'
import lucide from '../assets/icons-lucide.json' with { type: 'json' }

export type LucideIconElement =
  | { readonly tag: 'path'; readonly d: string }
  | {
      readonly tag: 'rect'
      readonly x: number
      readonly y: number
      readonly width: number
      readonly height: number
      readonly rx?: number
    }
  | { readonly tag: 'circle'; readonly cx: number; readonly cy: number; readonly r: number }
  | {
      readonly tag: 'ellipse'
      readonly cx: number
      readonly cy: number
      readonly rx: number
      readonly ry: number
    }

export const LUCIDE_VIEWBOX = '0 0 24 24'

/** The set as registered assets, keyed by bare name in the file's (sorted) order. */
export const LUCIDE_ASSETS: Readonly<Record<string, IconAsset>> = assetTable(
  'icon',
  lucide,
  iconAssetSchema,
)

export const LUCIDE_ICONS: Readonly<Record<string, ReadonlyArray<LucideIconElement>>> =
  Object.fromEntries(Object.entries(LUCIDE_ASSETS).map(([name, asset]) => [name, asset.geometry]))

/**
 * The vendored geometry for `name`, or undefined when the set does not
 * carry it — the one lookup a document-supplied name may go through.
 *
 * `LUCIDE_ICONS` is a plain object, so indexing it by `constructor`,
 * `toString` or `__proto__` answers an inherited function or the prototype
 * itself; a caller iterating that throws, and the symbol facet admits any
 * non-empty name. An own-property check makes such a name degrade like any
 * unknown one.
 */
export function iconGeometry(name: string): ReadonlyArray<LucideIconElement> | undefined {
  return Object.hasOwn(LUCIDE_ICONS, name) ? LUCIDE_ICONS[name] : undefined
}

/**
 * The vendored set's names, sorted — the published answer to "which icons
 * can this renderer draw". A picker offers exactly these, so an editor
 * never lists a name the backend would silently drop.
 */
export const BUILT_IN_ICON_NAMES: readonly string[] = Object.keys(LUCIDE_ICONS)

/**
 * This set as the renderer consumes it: the geometry above, plus the
 * coordinate space it is drawn in and the paint it is authored for.
 *
 * Declared HERE rather than defaulted in the renderer, because they are
 * properties of this icon set and not of drawing icons in general — a
 * contributed set in a different space, or one that fills rather than
 * strokes, is equally valid and says so the same way.
 */
export const VISUAL_ICONS: Readonly<
  Record<
    string,
    {
      readonly geometry: ReadonlyArray<LucideIconElement>
      readonly viewBox: string
      readonly paint: Readonly<Record<string, string | number>>
    }
  >
> = Object.fromEntries(
  Object.entries(LUCIDE_ICONS).map(([name, geometry]) => [
    name,
    {
      geometry,
      viewBox: LUCIDE_VIEWBOX,
      // Lucide's own convention: outline only, so the stroke COLOR is the
      // single thing a referencing `<use>` assigns.
      paint: {
        fill: 'none',
        'stroke-width': 2,
        'stroke-linecap': 'round',
        'stroke-linejoin': 'round',
      },
    },
  ]),
)
