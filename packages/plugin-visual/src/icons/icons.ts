/**
 * Vendored lucide icon geometry (see README.md for provenance, license and
 * the extend-me recipe). Each icon is a list of primitive elements in the
 * 24x24 lucide viewBox; paint is deliberately absent — the SVG backend
 * wraps them in a stroke-styled group and the referencing `<use>` assigns
 * the color, so the table stays pure geometry.
 */

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

export const LUCIDE_ICONS: Readonly<Record<string, ReadonlyArray<LucideIconElement>>> = {
  database: [
    { tag: 'ellipse', cx: 12, cy: 5, rx: 9, ry: 3 },
    { tag: 'path', d: 'M3 5V19A9 3 0 0 0 21 19V5' },
    { tag: 'path', d: 'M3 12A9 3 0 0 0 21 12' },
  ],
  file: [
    {
      tag: 'path',
      d: 'M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z',
    },
    { tag: 'path', d: 'M14 2v5a1 1 0 0 0 1 1h5' },
  ],
  image: [
    { tag: 'rect', x: 3, y: 3, width: 18, height: 18, rx: 2 },
    { tag: 'circle', cx: 9, cy: 9, r: 2 },
    { tag: 'path', d: 'm21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21' },
  ],
  layers: [
    {
      tag: 'path',
      d: 'M12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83z',
    },
    { tag: 'path', d: 'M2 12a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 12' },
    { tag: 'path', d: 'M2 17a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 17' },
  ],
  link: [
    { tag: 'path', d: 'M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71' },
    { tag: 'path', d: 'M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71' },
  ],
  lock: [
    { tag: 'rect', x: 3, y: 11, width: 18, height: 11, rx: 2 },
    { tag: 'path', d: 'M7 11V7a5 5 0 0 1 10 0v4' },
  ],
  network: [
    { tag: 'rect', x: 16, y: 16, width: 6, height: 6, rx: 1 },
    { tag: 'rect', x: 2, y: 16, width: 6, height: 6, rx: 1 },
    { tag: 'rect', x: 9, y: 2, width: 6, height: 6, rx: 1 },
    { tag: 'path', d: 'M5 16v-3a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1v3' },
    { tag: 'path', d: 'M12 12V8' },
  ],
  server: [
    { tag: 'rect', x: 2, y: 2, width: 20, height: 8, rx: 2 },
    { tag: 'rect', x: 2, y: 14, width: 20, height: 8, rx: 2 },
    { tag: 'path', d: 'M6 6h.01' },
    { tag: 'path', d: 'M6 18h.01' },
  ],
  star: [
    {
      tag: 'path',
      d: 'M11.525 2.295a.53.53 0 0 1 .95 0l2.31 4.679a2.123 2.123 0 0 0 1.595 1.16l5.166.756a.53.53 0 0 1 .294.904l-3.736 3.638a2.123 2.123 0 0 0-.611 1.878l.882 5.14a.53.53 0 0 1-.771.56l-4.618-2.428a2.122 2.122 0 0 0-1.973 0L6.396 21.01a.53.53 0 0 1-.77-.56l.881-5.139a2.122 2.122 0 0 0-.611-1.879L2.16 9.795a.53.53 0 0 1 .294-.906l5.165-.755a2.122 2.122 0 0 0 1.597-1.16z',
    },
  ],
  user: [
    { tag: 'path', d: 'M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2' },
    { tag: 'circle', cx: 12, cy: 7, r: 4 },
  ],
}

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
export const BUILT_IN_ICON_NAMES: readonly string[] = Object.keys(LUCIDE_ICONS).sort()

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
