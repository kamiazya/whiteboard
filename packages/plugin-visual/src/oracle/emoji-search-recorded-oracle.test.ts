import { readFileSync, writeFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { emojiSearchTerms, emojiSearchText } from '../emoji/searchable.js'
import { recordedTexts } from '../test-utils/shortcode-oracle.js'

/**
 * What `emojiSearchText` lends a search index, recorded for the Rust port to
 * replay exactly (`crates/core/plugin-visual/tests/emoji_search_oracle.rs`).
 *
 * The texts are the shortcode oracle's (colons in every arrangement, real and
 * near-miss slugs, astral characters), every catalog character on its own, one
 * in sixteen inside a sentence, and the cases on the gate's edges: a keycap or a flag is
 * a catalog row but not `Extended_Pictographic`, so alone it lends nothing and
 * beside a pictograph it lends its row; a character shown twice, or shown and
 * written as a shortcode, lends its row once. Re-record after a deliberate
 * change with
 * `WHITEBOARD_RECORD_ORACLE=1 pnpm vitest run --project plugin-visual-node emoji-search-recorded`.
 */
const FILE = new URL('./emoji-search.jsonl', import.meta.url)

interface Line {
  readonly in: string
  readonly out: string
}

const EDGES: readonly string[] = [
  '#️⃣',
  '#️⃣ 🚀',
  '🇯🇵',
  '🇯🇵🚀',
  '🇯🇵🇺🇸',
  'go 🇯🇵 :rocket:',
  '🚀🚀🚀',
  '🚀 :rocket: 🚀',
  ':rocket: :rocket:',
  '👍🏽 skin tone',
  '👍🏽👍',
  '☺ without a selector',
  '☺️ with a selector',
  '©',
  '© 2026',
  '™ trademark',
  '👨‍👩‍👧',
  '👨‍👩‍👧‍👦 and 👩‍❤️‍👨',
  '👨‍',
  '‍👩',
  '🫠🫨🪿',
  '🏳️‍🌈 flag',
  '🏴‍☠️',
  'é🚀é',
  'line\n🚀\nbreak',
  '🔥:fire:🔥',
  'no emoji, no colon',
  ':',
  '::',
  '🚀:',
  ':🚀:',
]

function texts(): string[] {
  const catalog = [...emojiSearchTerms().keys()]
  const seen = new Set<string>()
  const all: string[] = []
  for (const text of [
    ...recordedTexts(),
    ...EDGES,
    ...catalog,
    ...catalog.filter((_, at) => at % 16 === 0).map((char) => `see ${char}, then the next`),
  ]) {
    if (seen.has(text)) continue
    seen.add(text)
    all.push(text)
  }
  return all
}

const record = (): Line[] => texts().map((text) => ({ in: text, out: emojiSearchText(text) }))

if (process.env.WHITEBOARD_RECORD_ORACLE === '1') {
  writeFileSync(
    FILE,
    `${record()
      .map((line) => JSON.stringify(line))
      .join('\n')}\n`,
  )
}

const read = () =>
  readFileSync(FILE, 'utf8')
    .trimEnd()
    .split('\n')
    .map((line) => JSON.parse(line) as Line)

describe('the recorded emoji search oracle', () => {
  it('reaches a text that lends nothing, one row and several', () => {
    const recorded = read()
    const lent = recorded.filter((line) => line.out !== '')
    expect(recorded.length - lent.length, 'texts lending nothing').toBeGreaterThan(500)
    expect(lent.length, 'texts lending a row').toBeGreaterThan(1900)
    const keycap = recorded.find((line) => line.in === '#️⃣')
    expect(keycap?.out, 'a keycap alone is past the gate').toBe('')
    expect(recorded.find((line) => line.in === '#️⃣ 🚀')?.out).toContain('keycap')
  })

  it('holds what emojiSearchText answers today', () => {
    expect(read()).toEqual(record())
  })
})
