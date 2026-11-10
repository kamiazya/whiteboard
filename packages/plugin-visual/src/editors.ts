/**
 * The symbol catalog's loader: the one part of a facet's editor that is code
 * rather than data, so it stays out of `visual.manifest.json`, which names it.
 */
import type { FacetPickerCatalogSection } from '@kamiazya/whiteboard-facet-engine'
import { BUILT_IN_ICON_NAMES } from './icons/icons.js'

/**
 * Other words for what each vendored icon depicts, so a search by the
 * concept a person has in mind ("storage", "secure") finds the picture. Only
 * honest synonyms: a word with no icon behind it finds nothing rather than
 * a near miss.
 */
const ICON_ALIASES: Readonly<Record<string, readonly string[]>> = {
  database: ['datastore', 'storage', 'db', 'sql', 'table'],
  file: ['document', 'page', 'paper'],
  image: ['picture', 'photo', 'png'],
  link: ['url', 'hyperlink', 'chain', 'reference'],
  lock: ['secure', 'security', 'private', 'padlock'],
  star: ['favorite', 'favourite', 'bookmark', 'rating'],
}

/**
 * The vendored icons as the catalog's first band.
 *
 * Derived from the vendored set rather than written out, so an icon added
 * to `LUCIDE_ICONS` reaches the picker with no second edit — the drift that
 * put a name in one place and not the other cannot happen. It is built HERE
 * rather than in `emoji/sections.ts` because it is this build's own
 * geometry rather than Unicode's data, and it costs no bytes worth
 * deferring.
 */
const ICON_SECTION: FacetPickerCatalogSection = {
  label: 'Icons',
  glyph: { kind: 'asset', id: 'visual.category-icons' },
  keywords: ['アイコン 記号 図形'],
  options: BUILT_IN_ICON_NAMES.map((name) => ({
    payload: { kind: 'icon' as const, name },
    label: `Icon ${name}`,
    keywords: [name, ...(ICON_ALIASES[name] ?? [])],
    glyph: { kind: 'asset' as const, id: `visual.${name}` },
  })),
}

/**
 * The symbol picker's catalog, which the manifest names as `visual.symbols`:
 * the vendored icons as a first band, then every emoji Unicode publishes.
 *
 * DERIVED from the standard rather than curated (`scripts/
 * generate-emoji-catalog.mjs`): "which two hundred emoji does this product
 * like" has no defensible answer and goes stale each Unicode release.
 *
 * A LOADER rather than rows because the plugin definition is read wherever a
 * document is, and none of those draws a picker. The dynamic import is what
 * keeps the emoji tables a separate chunk; the manifest holds the label and
 * the free-entry template, which are data.
 */
export const symbolCatalogLoad = async (): Promise<readonly FacetPickerCatalogSection[]> => [
  ICON_SECTION,
  ...(await import('./emoji/sections.js')).emojiSections(),
]
