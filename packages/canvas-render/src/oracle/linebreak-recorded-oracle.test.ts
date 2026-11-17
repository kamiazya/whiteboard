import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type {
  DigestRecord,
  OracleRecord,
  TextRecord,
} from '../test-utils/linebreak-oracle/oracle.js'

/**
 * The committed recording of where `uaxSegments` (`css-line-break` 2.1.0,
 * `strict`, `normal`) broke a text, taken from the TypeScript before it and
 * the dependency were deleted (ADR-0054 step 7, S18h) and frozen. The Rust
 * port replays it exactly (`tests/linebreak_oracle.rs` in
 * `crates/core/canvas-render`), and the class table it reads is frozen with
 * the crate. This test holds the recording to the inputs it must reach.
 */
const FILE = new URL('./linebreak.jsonl', import.meta.url)

describe('the recorded line-break oracle', () => {
  const text = readFileSync(FILE, 'utf8')
  const recorded = text
    .trimEnd()
    .split('\n')
    .map((line) => JSON.parse(line) as OracleRecord)
  const texts = recorded.filter((r): r is TextRecord => r.kind === 'text')
  const digests = recorded.filter((r): r is DigestRecord => r.kind === 'digest')

  it('reaches every corpus, every class pair and every chunk of the large ones', () => {
    const per = (c: string) => texts.filter((r) => r.c === c).length
    expect(per('edge')).toBeGreaterThanOrEqual(24)
    expect(per('real')).toBeGreaterThanOrEqual(21)
    const meta = recorded[0]
    expect(meta?.kind).toBe('meta')
    const reps = meta?.kind === 'meta' ? meta.reps.length : 0
    expect(reps, 'one representative per raw value and the numbered code points').toBeGreaterThan(
      60,
    )
    expect(per('pairs')).toBe(reps * reps)
    const chunks = (c: string) => digests.filter((r) => r.c === c)
    expect(chunks('triples')).toHaveLength(reps)
    expect(chunks('mixed')).toHaveLength(200)
    expect(chunks('census-kanji').length).toBeGreaterThan(30)
    expect(chunks('census-latin').length).toBeGreaterThan(30)
    expect(chunks('raw')).toHaveLength(272)
  })

  it('records answers that break somewhere and nowhere', () => {
    const withBreaks = texts.filter((r) => r.b.length > 0).length
    expect(withBreaks, 'recorded texts with a break').toBeGreaterThan(texts.length / 4)
    expect(texts.filter((r) => r.b.length === 0).length, 'and without').toBeGreaterThan(100)
    expect(texts.filter((r) => 'u' in r).length, 'texts holding a lone surrogate').toBeGreaterThan(
      20,
    )
  })
})
