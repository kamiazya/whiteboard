import { readFileSync, writeFileSync } from 'node:fs'
import type { Encoded } from '@kamiazya/whiteboard-model/test-utils'
import { describe, expect, it } from 'vitest'
import { answerReadAgain, type ReadLine, recordReadLines } from '../test-utils/facet-read-oracle.js'
import type { RecordedLine } from '../test-utils/facet-write-oracle.js'

/**
 * The committed recording of the plugin's facet readers equals what they
 * answer today. The Rust readers replay it exactly
 * (`crates/core/plugin-visual/tests/facet_read_oracle.rs`). Its payloads are
 * the write recording's, so re-record this one after that one, with
 * `WHITEBOARD_RECORD_ORACLE=1 pnpm vitest run --project plugin-visual-node facet-read-recorded`.
 */
const FILE = new URL('./facet-read.jsonl', import.meta.url)
const WRITES = new URL('./facet-write.jsonl', import.meta.url)

const linesOf = <T>(url: URL): T[] =>
  readFileSync(url, 'utf8')
    .trimEnd()
    .split('\n')
    .map((line) => JSON.parse(line) as T)

if (process.env.WHITEBOARD_RECORD_ORACLE === '1') {
  const writes = linesOf<RecordedLine>(WRITES).flatMap((line) =>
    line.k === 'w' ? [[line.key, line.in] as const satisfies readonly [string, Encoded]] : [],
  )
  writeFileSync(
    FILE,
    `${recordReadLines(writes)
      .map((line) => JSON.stringify(line))
      .join('\n')}\n`,
  )
}

describe('the recorded facet read oracle', () => {
  const recorded = linesOf<ReadLine>(FILE)

  it('reaches every reader with a payload it reads and one it does not', () => {
    for (const reader of [
      'shape',
      'text',
      'edges',
      'canvas-edges',
      'stroke',
      'theme',
      'stencil',
      'symbol',
    ]) {
      const mine = recorded.filter((line) => line.reader === reader)
      const read = mine.filter((line) => JSON.stringify(line.out) !== JSON.stringify(mine[0]?.out))
      expect(mine.length, `${reader} lines`).toBeGreaterThan(100)
      expect(read.length, `${reader} answered a payload`).toBeGreaterThan(20)
    }
    const symbols = JSON.stringify(recorded.filter((line) => line.reader === 'symbol'))
    expect(symbols, 'an emoji').toContain('"kind":"emoji"')
    expect(symbols, 'an icon').toContain('"kind":"icon"')
  })

  it('equals what the TypeScript answers today', () => {
    const parted = recorded.findIndex(
      (line) => JSON.stringify(answerReadAgain(line)) !== JSON.stringify(line),
    )
    expect(parted, 'the first line the TypeScript no longer answers as recorded').toBe(-1)
  })
})
