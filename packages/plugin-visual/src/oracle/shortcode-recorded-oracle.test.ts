import { readFileSync, writeFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  recordShortcodeLines,
  type ShortcodeLine,
  shortcodeLineOf,
} from '../test-utils/shortcode-oracle.js'

/**
 * The committed recording of the two shortcode scans equals what they answer
 * today. The Rust scans replay it exactly
 * (`crates/core/plugin-visual/tests/shortcode_oracle.rs`). Re-record after a
 * deliberate change with
 * `WHITEBOARD_RECORD_ORACLE=1 pnpm vitest run --project plugin-visual-node shortcode-recorded`.
 */
const FILE = new URL('./shortcode.jsonl', import.meta.url)

if (process.env.WHITEBOARD_RECORD_ORACLE === '1') {
  writeFileSync(
    FILE,
    `${recordShortcodeLines()
      .map((line) => JSON.stringify(line))
      .join('\n')}\n`,
  )
}

describe('the recorded shortcode oracle', () => {
  const recorded = readFileSync(FILE, 'utf8')
    .trimEnd()
    .split('\n')
    .map((line) => JSON.parse(line) as ShortcodeLine)

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

  it('equals what the TypeScript answers today', () => {
    const fresh = recordShortcodeLines()
    expect(recorded).toHaveLength(fresh.length)
    const parted = recorded.findIndex(
      (line) => JSON.stringify(shortcodeLineOf(line.in)) !== JSON.stringify(line),
    )
    expect(parted, 'the first line the TypeScript no longer answers as recorded').toBe(-1)
    expect(recorded.map((line) => line.in)).toEqual(fresh.map((line) => line.in))
  })
})
