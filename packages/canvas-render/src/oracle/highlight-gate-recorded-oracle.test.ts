import { readFileSync, writeFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { createTokenizerBudget } from '../highlight/tokenizer-budget.js'
import {
  type HighlightGateRecord,
  highlightGateAnswer,
  highlightGateInputs,
} from '../test-utils/highlight-gate-oracle.js'

/**
 * The committed recording of which fences the default highlighter colours,
 * and what each spends of a layout's tokenizer account, equals what it
 * answers today; the Rust gate replays it exactly
 * (`tests/highlight_gate_oracle.rs` in `crates/core/canvas-render`).
 * Re-record after a deliberate change with
 * `WHITEBOARD_RECORD_ORACLE=1 pnpm vitest run --project canvas-render-node highlight-gate-recorded`.
 */
const FILE = new URL('./highlight-gate.jsonl', import.meta.url)

if (process.env.WHITEBOARD_RECORD_ORACLE === '1') {
  const lines = highlightGateInputs().map((input) => JSON.stringify(highlightGateAnswer(input)))
  writeFileSync(FILE, `${lines.join('\n')}\n`)
}

const records = readFileSync(FILE, 'utf8')
  .trimEnd()
  .split('\n')
  .map((line) => JSON.parse(line) as HighlightGateRecord)

describe('the recorded highlight gate oracle', () => {
  it('reaches every way a fence is coloured or left plain', () => {
    const coloured = records.filter((r) => r.colours)
    expect(coloured.length, 'coloured').toBeGreaterThan(150)
    expect(records.length - coloured.length, 'plain').toBeGreaterThan(150)
    const opened = createTokenizerBudget()
    const before = (r: HighlightGateRecord) =>
      r.budget === 'fresh'
        ? { word: opened.wordRunsRemaining, line: opened.lineRunsRemaining, refused: 0 }
        : r.budget
    const moved = (key: 'word' | 'line' | 'refused') => (r: HighlightGateRecord) => {
      const start = before(r)
      return start !== null && r.after !== null && r.after[key] !== start[key]
    }
    expect(records.filter(moved('word')).length, 'word runs spent').toBeGreaterThan(20)
    expect(records.filter(moved('line')).length, 'line runs spent').toBeGreaterThan(10)
    expect(records.filter(moved('refused')).length, 'refused by the account').toBeGreaterThan(20)
    const fresh = records.filter((r) => r.budget === 'fresh')
    expect(fresh.filter(moved('line')).length, 'a layout account spending a line').toBeGreaterThan(
      3,
    )
  })

  it('equals what the TypeScript answers today', () => {
    type Inputs = Pick<HighlightGateRecord, 'id' | 'lang' | 'value' | 'budget'>
    const inputOf = ({ id, lang, value, budget }: Inputs) => ({
      id,
      lang,
      value,
      budget,
    })
    expect(records.map(inputOf), "the recorded inputs are today's").toEqual(
      highlightGateInputs().map(inputOf),
    )
    const parted = records.findIndex(
      (r) => JSON.stringify(highlightGateAnswer(r)) !== JSON.stringify(r),
    )
    expect(records[parted]?.id, 'the first case answered otherwise').toBeUndefined()
  })
})
