import { readFileSync, writeFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { recordedLines } from '../test-utils/search-oracle.js'

/**
 * The committed recording of what this package answers, which the Rust port
 * replays (`crates/core/search/tests/search_oracle.rs`). It is regenerated
 * from the TypeScript, so it fails when the TypeScript stops answering as
 * recorded. Re-record after a deliberate change with
 * `WHITEBOARD_RECORD_ORACLE=1 pnpm vitest run --project search-node search-recorded`.
 */
const FILE = new URL('./search.jsonl', import.meta.url)

const lines = recordedLines()

if (process.env.WHITEBOARD_RECORD_ORACLE === '1') writeFileSync(FILE, `${lines.join('\n')}\n`)

describe('the recorded search oracle', () => {
  const recorded = readFileSync(FILE, 'utf8').trimEnd().split('\n')

  it('reaches every function, a hit and a miss, and an ill-formed input', () => {
    const kinds = new Map<string, number>()
    for (const line of recorded) {
      const kind = (JSON.parse(line) as { kind: string }).kind
      kinds.set(kind, (kinds.get(kind) ?? 0) + 1)
    }
    for (const kind of ['fold', 'find', 'tokens', 'terms', 'snippet', 'excerpt', 'search']) {
      expect(kinds.get(kind), kind).toBeGreaterThan(100)
    }
    for (const kind of ['searchable-texts', 'folders', 'labels', 'fold-table', 'word-table']) {
      expect(kinds.get(kind), kind).toBeGreaterThan(0)
    }
    const finds = recorded.map((line) => JSON.parse(line) as { kind: string; at?: unknown })
    expect(finds.filter((r) => r.kind === 'find' && r.at !== null).length).toBeGreaterThan(500)
    expect(finds.filter((r) => r.kind === 'find' && r.at === null).length).toBeGreaterThan(500)
    expect(recorded.filter((line) => line.includes('"units"')).length).toBeGreaterThan(20)
  })

  it('holds what the TypeScript answers today', () => {
    expect(lines.length).toBe(recorded.length)
    const parted = lines.findIndex((line, i) => line !== recorded[i])
    expect(parted, 'the first line the TypeScript no longer answers as recorded').toBe(-1)
  })
})
