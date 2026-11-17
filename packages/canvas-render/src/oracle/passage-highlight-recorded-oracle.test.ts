import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { PassageHighlightRecord } from '../test-utils/passage-highlight-oracle.js'

/**
 * The committed recording of what the passage highlights and the searches
 * they run answered, taken from the TypeScript before it was deleted
 * (ADR-0054 step 7, S18h) and frozen. The Rust port replays it exactly
 * (`tests/passage_highlight_oracle.rs` in `crates/core/canvas-render`). This
 * test holds the recording to the inputs it must reach.
 */
const FILE = new URL('./passage-highlight.jsonl', import.meta.url)

const records = readFileSync(FILE, 'utf8')
  .trimEnd()
  .split('\n')
  .map((line) => JSON.parse(line) as PassageHighlightRecord)

const boards = records.flatMap((r) => (r.kind === 'highlights' ? [r] : []))

describe('the recorded passage-highlight oracle', () => {
  it('reaches drawn, undrawn, settled and clamped highlights', () => {
    const shapes = boards.flatMap((r) => r.answer.shapes)
    expect(shapes.filter(([, , look]) => look === 'open').length).toBeGreaterThan(50)
    expect(shapes.filter(([, , look]) => look === 'resolved').length).toBeGreaterThan(20)
    expect(boards.filter((r) => r.answer.shapes.length === 0).length).toBeGreaterThan(1)
    expect(shapes.filter(([id]) => /passage-[1-9]$/.test(id)).length).toBeGreaterThan(10)
    expect(boards.some((r) => r.measure === 'odd')).toBe(true)
    const resolved = records.flatMap((r) => (r.kind === 'resolve' ? [r] : []))
    expect(resolved.filter((r) => r.answer === null).length).toBeGreaterThan(20)
    expect(
      resolved.filter((r) => r.answer !== null && r.answer[0] !== r.start).length,
    ).toBeGreaterThan(50)
  })
})
