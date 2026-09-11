/**
 * The generated Unicode rows, as the catalog vocabulary a picker reads.
 *
 * A separate module from `data.ts` on purpose, reached by DYNAMIC import:
 * the facet definition is loaded wherever a document is read — the SVG
 * renderer, the layout worker, the MCP server — and none of those opens a
 * picker. Statically imported the 69KB table would ride into every one of
 * those graphs. A dynamic import is the only thing a bundler treats as a
 * separate chunk, which is why `FacetPickerCatalogSpec.load` returns a
 * promise rather than a list.
 */
import type { FacetPickerCatalogSection } from '@kamiazya/whiteboard-facet-engine'
import { EMOJI_GROUPS } from './catalog-data.js'

/**
 * Unicode's group name -> the registered glyph the category chooser wears.
 *
 * Hand-mapped, and it has to be: the names are a published vocabulary that
 * changes only when Unicode says so, and nothing in the data says a rocket
 * category should be pictured by a paper plane. A group with no entry falls
 * back to its own first emoji, which is the picture this table exists to
 * stop being the default — so `catalog.test.ts` fails on one, from both
 * sides.
 */
const CATEGORY_GLYPH: Readonly<Record<string, string>> = {
  'Smileys & Emotion': 'visual.category-smileys',
  'People & Body': 'visual.category-people',
  'Animals & Nature': 'visual.category-nature',
  'Food & Drink': 'visual.category-food',
  'Travel & Places': 'visual.category-travel',
  Activities: 'visual.category-activities',
  Objects: 'visual.category-objects',
  Symbols: 'visual.category-symbols',
  Flags: 'visual.category-flags',
}

/**
 * Built once and remembered: a picker mounts every time the inspector shows
 * a node, and rebuilding 1914 option objects each time is work whose answer
 * cannot have changed — the table is a frozen constant.
 */
let built: readonly FacetPickerCatalogSection[] | undefined

export function emojiSections(): readonly FacetPickerCatalogSection[] {
  built ??= EMOJI_GROUPS.map(([label, rows]) => {
    const id = CATEGORY_GLYPH[label]
    return {
      label,
      ...(id === undefined ? {} : { glyph: { kind: 'asset' as const, id } }),
      options: rows.split('\n').map((row) => {
        const [char, name, subgroup] = row.split('\t')
        return {
          payload: { kind: 'emoji', char },
          // The CLDR short name, which is what a person reading a tooltip
          // wants and what the search matches first.
          label: name as string,
          keywords: [subgroup as string],
          glyph: { kind: 'char', value: char as string },
        } as const
      }),
    }
  })
  return built
}
