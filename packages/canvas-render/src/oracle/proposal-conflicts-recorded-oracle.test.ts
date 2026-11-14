import { readFileSync, writeFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  type ProposalConflictsRecord,
  proposalConflictsRecords,
} from '../test-utils/proposal-oracle/conflicts.js'

/**
 * The committed recording of whether a proposed change still fits its board
 * (`canvasChangeConflicts`) equals what the TypeScript answers today, and the
 * Rust port replays it exactly (`tests/compose_canvas_support/proposals.rs` in
 * `crates/core/canvas-render`). Re-record after a deliberate change with
 * `WHITEBOARD_RECORD_ORACLE=1 pnpm vitest run --project canvas-render-node proposal-conflicts-recorded`.
 */
const FILE = new URL('./proposal-conflicts.jsonl', import.meta.url)

const fresh = proposalConflictsRecords()

if (process.env.WHITEBOARD_RECORD_ORACLE === '1') {
  writeFileSync(FILE, `${fresh.map((r) => JSON.stringify(r)).join('\n')}\n`)
}

const records = readFileSync(FILE, 'utf8')
  .trimEnd()
  .split('\n')
  .map((line) => JSON.parse(line) as ProposalConflictsRecord)

const cases = records.flatMap((r) => (r.kind === 'case' ? [r] : []))

describe('the recorded proposal-conflicts oracle', () => {
  it('reaches both answers for every canvas arm', () => {
    const ops = ['node', 'edge', 'line'].flatMap((el) =>
      ['add', 'patch', 'remove'].map((verb) => `${el}.${verb}`),
    )
    for (const op of ops) {
      for (const answer of [true, false]) {
        expect(
          cases.some((c) => c.change.op === op && c.conflicts === answer),
          `${op} answering ${answer}`,
        ).toBe(true)
      }
    }
  })

  it('equals what the TypeScript answers today', () => {
    const parted = records.findIndex((r, i) => JSON.stringify(fresh[i]) !== JSON.stringify(r))
    expect(parted, 'the first record the TypeScript no longer answers as recorded').toBe(-1)
    expect(records).toHaveLength(fresh.length)
  })
})
