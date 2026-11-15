/**
 * `emoji-shortcodes.tsv` is the emoji table the Rust core reads a shortcode
 * through (`crates/core/plugin-visual`'s `shortcode` module): one
 * `slug<TAB>character` row per catalog row, in catalog order, so the first row
 * of a slug answers it as `expandEmojiShortcodes` does. It is generated beside
 * `catalog-data.ts` and held here to `EMOJI_GROUPS` read through `emojiSlug`,
 * so the slug rule has one implementation and the two realms one vocabulary.
 * Regenerate with the catalog generator, or with
 * `WHITEBOARD_RECORD_ORACLE=1 pnpm vitest run --project plugin-visual-node shortcode-table`.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { EMOJI_GROUPS } from './catalog-data.js'
import { emojiForShortcode } from './shortcode.js'
import { emojiSlug } from './slug.js'

const FILE = new URL('./emoji-shortcodes.tsv', import.meta.url)

const rows = EMOJI_GROUPS.flatMap(([, block]) =>
  block.split('\n').map((row) => {
    const [char = '', name = ''] = row.split('\t')
    return `${emojiSlug(name)}\t${char}`
  }),
)

if (process.env.WHITEBOARD_RECORD_ORACLE === '1') writeFileSync(FILE, `${rows.join('\n')}\n`)

describe('the emoji shortcode table the core reads', () => {
  const committed = readFileSync(FILE, 'utf8').trimEnd().split('\n')

  it('equals the catalog read through emojiSlug, row for row', () => {
    expect(committed.length).toBeGreaterThanOrEqual(1500)
    expect(committed).toEqual(rows)
  })

  it('answers every slug with the character expandEmojiShortcodes draws for it', () => {
    const first = new Map<string, string>()
    for (const row of committed) {
      const [slug = '', char = ''] = row.split('\t')
      if (!first.has(slug)) first.set(slug, char)
    }
    const differ = [...first].filter(([slug, char]) => emojiForShortcode(slug) !== char)
    expect(differ).toEqual([])
    expect(first.size).toBeGreaterThanOrEqual(1500)
  })
})
