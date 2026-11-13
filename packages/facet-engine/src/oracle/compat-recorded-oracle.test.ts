import { readFileSync, writeFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  answerCompatAgain,
  type CompatLine,
  compatRegistry,
  recordCompatLines,
} from '../test-utils/compat-oracle.js'

/**
 * The committed recording of the registry's read path equals what
 * `resolveFacetPayload` answers today. The Rust registry replays it
 * (`crates/core/facet-engine/tests/compat_oracle.rs`) exactly. Re-record after a
 * deliberate change with
 * `WHITEBOARD_RECORD_ORACLE=1 pnpm vitest run --project facet-engine-node compat-recorded`.
 */
const FILE = new URL('./compat.jsonl', import.meta.url)

if (process.env.WHITEBOARD_RECORD_ORACLE === '1') {
  writeFileSync(
    FILE,
    `${recordCompatLines()
      .map((line) => JSON.stringify(line))
      .join('\n')}\n`,
  )
}

describe('the recorded compat oracle', () => {
  const recorded = readFileSync(FILE, 'utf8')
    .trimEnd()
    .split('\n')
    .map((line) => JSON.parse(line) as CompatLine)

  it('reaches every outcome, a walked chain and a chain with a step missing', () => {
    expect(recorded.length, 'recorded lines').toBeGreaterThan(200)
    for (const out of ['resolved', 'dropped', 'preserved', 'passthrough']) {
      expect(recorded.filter((line) => line.out === out).length, out).toBeGreaterThan(5)
    }
    const walked = (key: string) =>
      recorded.filter((line) => line.key === key && line.out === 'resolved').length
    expect(walked('demo.note/v1'), 'two steps walked').toBeGreaterThan(0)
    expect(walked('demo.note/v2'), 'one step walked').toBeGreaterThan(0)
    expect(walked('demo.note/v03'), 'leading zeros read as the current version').toBeGreaterThan(0)
    expect(walked('demo.gap/v0'), 'a chain with a step missing').toBe(0)
  })

  it('equals what the TypeScript answers today', () => {
    const registry = compatRegistry()
    const parted = recorded.findIndex(
      (line) => JSON.stringify(answerCompatAgain(registry, line)) !== JSON.stringify(line),
    )
    expect(parted, 'the first line the TypeScript no longer answers as recorded').toBe(-1)
  })
})
