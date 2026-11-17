import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { ProposalConflictsRecord } from '../test-utils/proposal-oracle/conflicts.js'

/**
 * The committed recording of whether a proposed change still fits its board
 * (`canvasChangeConflicts`), taken from the TypeScript before it was deleted
 * (ADR-0054 step 7, S18h) and frozen. The Rust port replays it exactly
 * (`tests/compose_canvas_support/proposals.rs` in `crates/core/canvas-render`).
 * This test holds the recording to the answers it must reach.
 */
const FILE = new URL('./proposal-conflicts.jsonl', import.meta.url)

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
})
