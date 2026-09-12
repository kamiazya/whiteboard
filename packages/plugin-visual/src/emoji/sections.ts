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
import { EMOJI_JA } from './catalog-ja.js'
import { emojiSlug } from './slug.js'

/**
 * Unicode's group name -> what this build knows about that band: the
 * registered glyph its chip wears, and what it is called in Japanese.
 *
 * Hand-mapped, and it has to be: the group names are a published vocabulary
 * that changes only when Unicode says so, nothing in the data says a rocket
 * category should be pictured by a paper plane, and CLDR annotates emoji
 * rather than groups. A group with no entry falls back to its own first
 * emoji and to no Japanese at all, which is exactly what this table exists
 * to stop being the default — so `catalog.test.ts` fails on one, from both
 * sides.
 *
 * The Japanese here is band-level and earns its nine lines: per-emoji CLDR
 * keywords are specific (果物, 野菜), so before this `食べ物` found 7 of the
 * 131 rows in Food & Drink and `旅行` found 3 of 219.
 */
const CATEGORIES: Readonly<Record<string, { readonly glyph: string; readonly ja: string }>> = {
  'Smileys & Emotion': { glyph: 'visual.category-smileys', ja: '顔 感情 スマイリー' },
  'People & Body': { glyph: 'visual.category-people', ja: '人 体 手' },
  'Animals & Nature': { glyph: 'visual.category-nature', ja: '動物 自然 植物' },
  'Food & Drink': { glyph: 'visual.category-food', ja: '食べ物 飲み物 料理' },
  'Travel & Places': { glyph: 'visual.category-travel', ja: '旅行 場所 乗り物' },
  Activities: { glyph: 'visual.category-activities', ja: '活動 スポーツ イベント' },
  Objects: { glyph: 'visual.category-objects', ja: '物 道具' },
  Symbols: { glyph: 'visual.category-symbols', ja: '記号 マーク' },
  Flags: { glyph: 'visual.category-flags', ja: '旗 国旗' },
}

/**
 * Built once and remembered: a picker mounts every time the inspector shows
 * a node, and rebuilding 1914 option objects each time is work whose answer
 * cannot have changed — the tables are frozen constants.
 */
let built: readonly FacetPickerCatalogSection[] | undefined

/** `character -> CLDR Japanese terms`, from the generated index. */
function japaneseIndex(): ReadonlyMap<string, string> {
  const found = new Map<string, string>()
  for (const row of EMOJI_JA.split('\n')) {
    const tab = row.indexOf('\t')
    if (tab !== -1) found.set(row.slice(0, tab), row.slice(tab + 1))
  }
  return found
}

export function emojiSections(): readonly FacetPickerCatalogSection[] {
  if (built !== undefined) return built
  const japanese = japaneseIndex()
  built = EMOJI_GROUPS.map(([label, rows]) => {
    const category = CATEGORIES[label]
    return {
      label,
      ...(category === undefined
        ? {}
        : { glyph: { kind: 'asset' as const, id: category.glyph }, keywords: [category.ja] }),
      options: rows.split('\n').map((row) => {
        const [char, name, subgroup] = row.split('\t')
        const ja = japanese.get(char as string)
        const slug = emojiSlug(name as string)
        return {
          payload: { kind: 'emoji', char },
          // The CLDR short name, which is what a person reading a tooltip
          // wants and what the search matches first.
          label: name as string,
          // Its SHORTCODE, Unicode's own subgroup, then CLDR's Japanese
          // name and keywords.
          //
          // The slug is in here because it is what a person will type once
          // `:name:` exists, and because the search splits on whitespace —
          // `thumbs_up` finds nothing against a label reading `thumbs up`.
          // The LABEL stays English because the UI around it is, and
          // translating what is shown while leaving everything else would
          // be a half-localised panel; what is searched is a different
          // question, and a person typing 星 is looking for something this
          // build has.
          keywords: ja === undefined ? [slug, subgroup as string] : [slug, subgroup as string, ja],
          glyph: { kind: 'char', value: char as string },
        } as const
      }),
    }
  })
  return built
}
