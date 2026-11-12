import { readFileSync, writeFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  type SectionRecord,
  sectionAnswer,
  sectionInputs,
} from '../test-utils/typeset-oracle/section-oracle.js'

/**
 * The committed recording of what `selectMarkdownSection` answers equals what
 * it answers today, and the Rust port replays it exactly
 * (`tests/section_oracle.rs` in `crates/core/canvas-render`). Re-record after a
 * deliberate change with
 * `WHITEBOARD_RECORD_ORACLE=1 pnpm vitest run --project canvas-render-node section-recorded`.
 */
const FILE = new URL('./section.jsonl', import.meta.url)

if (process.env.WHITEBOARD_RECORD_ORACLE === '1') {
  const lines = sectionInputs().map((input) => JSON.stringify(sectionAnswer(input)))
  writeFileSync(FILE, `${lines.join('\n')}\n`)
}

const records = readFileSync(FILE, 'utf8')
  .trimEnd()
  .split('\n')
  .map((line) => JSON.parse(line) as SectionRecord)

describe('the recorded section oracle', () => {
  it('reaches found and missing sections, nesting, case folding and unicode', () => {
    expect(records.length).toBeGreaterThan(500)
    const found = records.filter((r) => r.range !== null)
    expect(found.length, 'sections found').toBeGreaterThan(100)
    expect(records.length - found.length, 'fragments that name nothing').toBeGreaterThan(100)
    expect(
      found.some((r) => r.range !== null && r.range[1] - r.range[0] > 3),
      'a nested section',
    ).toBe(true)
  })

  it('equals what the TypeScript answers today', () => {
    const parted = records.findIndex((r) => JSON.stringify(sectionAnswer(r)) !== JSON.stringify(r))
    expect(
      records[parted]?.id,
      'the first case the TypeScript no longer answers as recorded',
    ).toBeUndefined()
  })
})
