/**
 * What each bundled facet's EDITOR declares — the picker options, the
 * catalog, and the two segmented rows.
 *
 * Beside `data.ts` rather than in it because they answer a different
 * question. That file says what a facet IS: its schema, where a payload may
 * attach, how an old one migrates. This one says how a person MEETS it, and
 * it is the half that changes when somebody looks at the panel and does not
 * like what they see — which, on this plugin, is most of the changes.
 *
 * Not a split for size. `data.ts` crossed the 800-line budget and the guard
 * is what asked the question, but the answer was already sitting there: two
 * subjects in one file, one of them growing.
 */
import type {
  FacetPickerCatalogSection,
  FacetPickerCatalogSpec,
  FacetPickerOption,
  FacetSegmentedOption,
} from '@kamiazya/whiteboard-facet-engine'
import { BUILT_IN_ICON_NAMES } from './icons/icons.js'

/**
 * What the picker lists INLINE: absence, and nothing else.
 *
 * Two things used to sit here beside it, and each left for a different
 * reason. Five hardcoded EMOJI went because they were five of the nineteen
 * hundred the schema has always accepted — listing more would not have
 * fixed it, since a definition this file exports is loaded by the renderer,
 * the layout worker and the MCP server, none of which draws a picker.
 *
 * The vendored ICONS went because of how they looked next to what replaced
 * them (user decision, 2026-09-11): a row of monochrome line drawings
 * directly above a grid of full-colour emoji reads as two unrelated
 * palettes, and the row was also indistinguishable from the CATEGORY row
 * below it, which picks a view rather than a value. As the catalog's first
 * band they are a category like any other, so a grid is now all monochrome
 * or all colour and never half of each.
 *
 * Absence stays inline because it is the one choice that belongs to no
 * category and has to be reachable without browsing to one.
 */
export const SYMBOL_PICKER_OPTIONS: readonly FacetPickerOption[] = [
  { payload: null, label: 'No symbol', glyph: { kind: 'shape', name: 'none' } },
]

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
    keywords: [name],
    glyph: { kind: 'asset' as const, id: `visual.${name}` },
  })),
}

/**
 * Every emoji Unicode publishes, searchable, plus the way to write one it
 * does not.
 *
 * DERIVED from the standard rather than curated (`scripts/
 * generate-emoji-catalog.mjs`): "which two hundred emoji does this product
 * like" has no defensible answer and goes stale each Unicode release,
 * while the published set carries its own names and categories and is
 * already in the order a keyboard should show them.
 *
 * `entry` is what makes the picker honestly open. Its template says the
 * typed text is the `char` of an emoji payload and nothing more — what a
 * char may BE stays `visualSymbolFacetSchema`'s answer, at the write
 * boundary, so a skin-toned hand or a flag sequence this build never
 * listed is still one press away, and a two-character string is still
 * refused with the schema's own words.
 */
export const SYMBOL_CATALOG: FacetPickerCatalogSpec = {
  label: 'Search symbols',
  load: async () => [ICON_SECTION, ...(await import('./emoji/sections.js')).emojiSections()],
  entry: {
    label: 'Any character or emoji',
    // The placeholder names the SEARCH box, because free entry is not a
    // second control any more: typing a character the catalog lacks offers
    // it as the leading result. Two inputs for one gesture — the search
    // already matched a pasted character — was one input too many.
    placeholder: 'Search, or paste a symbol',
    payload: { kind: 'emoji' },
    field: 'char',
  },
}

/**
 * `visual.edges/v0`'s two rows, as data.
 *
 * Every value here is a stored one — neither row offers `value: null`,
 * because neither axis has an "absent" a person picks. Absence means "let
 * the theme decide", and the way back to it is picking the value the theme
 * already has: the write path canonicalises a pick equal to the effective
 * default down to no stored facet, so the row returns to following the
 * theme without a separate control saying so.
 */
export const EDGE_ROUTING_OPTIONS: readonly FacetSegmentedOption[] = [
  { value: 'straight', label: 'Straight', glyph: { kind: 'asset', id: 'visual.edge-straight' } },
  {
    value: 'orthogonal',
    label: 'Orthogonal',
    glyph: { kind: 'asset', id: 'visual.edge-orthogonal' },
  },
  { value: 'curved', label: 'Curved', glyph: { kind: 'asset', id: 'visual.edge-curved' } },
]

export const LINE_JUMP_OPTIONS: readonly FacetSegmentedOption[] = [
  { value: 'none', label: 'Off', glyph: { kind: 'asset', id: 'visual.line-jumps-off' } },
  { value: 'arc', label: 'On', glyph: { kind: 'asset', id: 'visual.line-jumps-on' } },
]
