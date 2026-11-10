import { readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { SPATIAL_SUITES } from '../test-utils/spatial-wasm/suites.js'
import { TYPESCRIPT_ONLY_TESTS } from '../test-utils/spatial-wasm/typescript-only.js'

/**
 * The two ledgers layer 1 for JSON Canvas stands on, each held from both
 * sides: the suites it runs are the suites that reach the codec, and the tests
 * it leaves on the TypeScript are still the tests that replace a module of it.
 */
const here = new URL('./', import.meta.url)
const sourceOf = (file: string): string => readFileSync(new URL(file, here), 'utf8')

// The modules through which a suite reaches `parseSpatial` or `serializeSpatial`.
const REACHES = /from '\.\/(parse|serialize|codecs)\.js'/

describe('the spatial suites layer 1 runs against the Rust core', () => {
  // The switch's own suite tests the switch, whose `ts` side the TypeScript
  // is, so it stays on the TypeScript, as `okf-core.test.ts` does for OKF.
  const suites = readdirSync(here).filter(
    (f) => f.endsWith('.test.ts') && !f.endsWith('.rust.test.ts') && f !== 'spatial-core.test.ts',
  )

  it('finds the suites it should', () => {
    expect(suites.length).toBeGreaterThan(8)
    expect(SPATIAL_SUITES.length).toBeGreaterThan(3)
  })

  it('lists every suite that reaches parseSpatial or serializeSpatial, and only those', () => {
    const reaching = suites.filter((f) => REACHES.test(sourceOf(f))).map((f) => `src/spatial/${f}`)
    expect([...SPATIAL_SUITES].sort()).toEqual(reaching.sort())
  })
})

describe('the spatial tests layer 1 runs on the TypeScript', () => {
  it.each(
    TYPESCRIPT_ONLY_TESTS,
  )('$title is still in $file and still replaces $replaces', (entry) => {
    const text = sourceOf(entry.file)
    const at = text.indexOf(`'${entry.title}'`)
    expect(at, `${entry.file} has no test titled ${entry.title}`).toBeGreaterThanOrEqual(0)
    const next = text.indexOf('\n  it', at + 1)
    expect(text.slice(at, next === -1 ? undefined : next)).toContain(entry.replaces)
  })
})
