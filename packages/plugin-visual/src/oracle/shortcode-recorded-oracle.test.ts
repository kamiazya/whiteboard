import { readFileSync, writeFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { expandEmojiShortcodes } from '../emoji/shortcode.js'
import { recordedTexts, type ShortcodeLine } from '../test-utils/shortcode-oracle.js'

/**
 * The committed recording of the two shortcode scans, which the Rust scans
 * replay exactly (`crates/core/plugin-visual/tests/shortcode_oracle.rs`). The
 * emoji expansion equals what the TypeScript answers today; the icon ranges
 * are frozen, their TypeScript deleted (ADR-0054 step 7, S18h). Re-record the
 * emoji half after a deliberate change with
 * `WHITEBOARD_RECORD_ORACLE=1 pnpm vitest run --project plugin-visual-node shortcode-recorded`,
 * which keeps every icon range as it is.
 */
const FILE = new URL('./shortcode.jsonl', import.meta.url)

const read = () =>
  readFileSync(FILE, 'utf8')
    .trimEnd()
    .split('\n')
    .map((line) => JSON.parse(line) as ShortcodeLine)

if (process.env.WHITEBOARD_RECORD_ORACLE === '1') {
  writeFileSync(
    FILE,
    `${read()
      .map((line) => JSON.stringify({ ...line, emoji: expandEmojiShortcodes(line.in) }))
      .join('\n')}\n`,
  )
}

describe('the recorded shortcode oracle', () => {
  const recorded = read()

  it('reaches both outcomes of both scans, and offsets past a surrogate pair', () => {
    const expanded = recorded.filter((line) => line.emoji !== line.in)
    const kept = recorded.filter((line) => line.emoji === line.in && line.in.includes(':'))
    const icons = recorded.filter((line) => line.icons.length > 0)
    const missedIcons = recorded.filter(
      (line) => line.in.includes(':icon-') && line.icons.length === 0,
    )
    expect(expanded.length, 'texts an emoji expanded').toBeGreaterThan(200)
    expect(kept.length, 'colon texts left as written').toBeGreaterThan(200)
    expect(icons.length, 'texts with an icon').toBeGreaterThan(100)
    expect(missedIcons.length, 'icon candidates naming none').toBeGreaterThan(50)
    const astral = icons.filter((line) => [...line.in].length !== line.in.length)
    expect(astral.length, 'icons after a character outside the BMP').toBeGreaterThan(5)
  })

  it('holds emoji expansions that equal what the TypeScript answers today', () => {
    const texts = recordedTexts()
    expect(recorded.map((line) => line.in)).toEqual(texts)
    const parted = recorded.findIndex((line) => expandEmojiShortcodes(line.in) !== line.emoji)
    expect(parted, 'the first line the TypeScript no longer expands as recorded').toBe(-1)
  })
})
