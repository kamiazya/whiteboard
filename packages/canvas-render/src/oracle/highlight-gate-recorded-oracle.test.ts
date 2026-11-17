import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  type HighlightGateRecord,
  highlightGateAnswer,
  highlightGateInputs,
} from '../test-utils/highlight-gate-oracle.js'

/**
 * The committed recording of which fences the default highlighter colours,
 * and what each spends of a layout's tokenizer account; the Rust gate replays
 * it exactly (`tests/highlight_gate_oracle.rs` in `crates/core/canvas-render`).
 * The layout's account is the core's alone, so a record made against one is
 * frozen as the TypeScript account answered it before its deletion
 * (ADR-0054 step 7, S18h3), and only a record made against none is still
 * held to what the TypeScript highlighter answers today.
 */
const FILE = new URL('./highlight-gate.jsonl', import.meta.url)

/**
 * The account a layout opens, as the recording was taken with it: four fences
 * at each per-fence price (`NestedLayoutBudget::WORD_RUNS`/`LINE_RUNS`).
 */
const FRESH = { word: 4 * 4096 * 4096, line: 4 * 8192 * 8192, refused: 0 }

const records = readFileSync(FILE, 'utf8')
  .trimEnd()
  .split('\n')
  .map((line) => JSON.parse(line) as HighlightGateRecord)

describe('the recorded highlight gate oracle', () => {
  it('reaches every way a fence is coloured or left plain', () => {
    const coloured = records.filter((r) => r.colours)
    expect(coloured.length, 'coloured').toBeGreaterThan(150)
    expect(records.length - coloured.length, 'plain').toBeGreaterThan(150)
    const before = (r: HighlightGateRecord) => (r.budget === 'fresh' ? FRESH : r.budget)
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

  it("records today's inputs, and the TypeScript answers the unbudgeted ones alike", () => {
    type Inputs = Pick<HighlightGateRecord, 'id' | 'lang' | 'value' | 'budget'>
    const inputOf = ({ id, lang, value, budget }: Inputs) => ({ id, lang, value, budget })
    expect(records.map(inputOf), "the recorded inputs are today's").toEqual(
      highlightGateInputs().map(inputOf),
    )
    const unbudgeted = records.filter(
      (r): r is HighlightGateRecord & { budget: null } => r.budget === null,
    )
    expect(unbudgeted.length, 'cases the TypeScript still answers').toBeGreaterThan(100)
    const parted = unbudgeted.findIndex(
      (r) => JSON.stringify(highlightGateAnswer(r)) !== JSON.stringify(r),
    )
    expect(unbudgeted[parted]?.id, 'the first case answered otherwise').toBeUndefined()
  })
})
