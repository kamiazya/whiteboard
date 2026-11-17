import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * The committed recording of where the vendored BudouX parser (`budoux@0.9.0`,
 * Japanese model) cut a text, taken from the TypeScript before it was deleted
 * (ADR-0054 step 7, S18h) and frozen. The Rust port replays it exactly
 * (`tests/budoux_oracle.rs` in `crates/core/canvas-render`), and its model
 * tables (`src/budoux/model.rs`) are now the only copy of the model. This test
 * holds the recording to the inputs it must reach.
 */
const FILE = new URL('./budoux.jsonl', import.meta.url)

type TextRecord =
  | { kind: 'text'; c: string; t: string; b: number[] }
  | { kind: 'text'; c: string; u: number[]; b: number[] }
interface DigestRecord {
  kind: 'digest'
  c: string
}
interface MetaRecord {
  kind: 'meta'
  entries: number
}
type OracleRecord = MetaRecord | TextRecord | DigestRecord

describe('the recorded BudouX oracle', () => {
  const recorded = readFileSync(FILE, 'utf8')
    .trimEnd()
    .split('\n')
    .map((line) => JSON.parse(line) as OracleRecord)
  const texts = recorded.filter((r): r is TextRecord => r.kind === 'text')
  const digests = recorded.filter((r): r is DigestRecord => r.kind === 'digest')
  const meta = recorded.find((r): r is MetaRecord => r.kind === 'meta')

  it('reaches every corpus, a string aimed at every model entry, and every chunk of the large ones', () => {
    const per = (c: string) => texts.filter((r) => r.c === c).length
    expect(per('real')).toBeGreaterThanOrEqual(30)
    expect(per('kana')).toBeGreaterThanOrEqual(10)
    expect(per('kanji')).toBeGreaterThanOrEqual(10)
    expect(per('scripts')).toBeGreaterThanOrEqual(20)
    expect(per('emoji')).toBeGreaterThanOrEqual(15)
    expect(meta?.entries, 'the model entries the recording was aimed at').toBe(1678)
    expect(per('entry')).toBe(meta?.entries)
    expect(digests.filter((r) => r.c === 'prefixes')).toHaveLength(per('real'))
    expect(digests.filter((r) => r.c === 'stream')).toHaveLength(100)
  })

  it('records answers that cut somewhere and nowhere', () => {
    expect(texts.filter((r) => r.b.length > 0).length, 'texts with a boundary').toBeGreaterThan(
      texts.length / 2,
    )
    expect(texts.filter((r) => r.b.length === 0).length, 'and without').toBeGreaterThan(10)
    expect(texts.filter((r) => 'u' in r).length, 'texts holding a lone surrogate').toBeGreaterThan(
      5,
    )
  })
})
