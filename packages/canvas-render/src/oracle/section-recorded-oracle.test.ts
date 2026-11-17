import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { SectionRecord } from '../test-utils/typeset-oracle/section-oracle.js'

/**
 * The committed recording of what `selectMarkdownSection` answered, taken
 * from the TypeScript before it was deleted (ADR-0054 step 7, S18h) and
 * frozen. The Rust port replays it exactly (`tests/section_oracle.rs` in
 * `crates/core/canvas-render`). This test holds the recording to the inputs
 * it must reach.
 */
const FILE = new URL('./section.jsonl', import.meta.url)

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
})
