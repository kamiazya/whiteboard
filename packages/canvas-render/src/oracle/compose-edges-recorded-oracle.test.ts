import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { ComposeEdgesRecord } from '../test-utils/compose-edges-oracle/oracle.js'

/**
 * The committed recording of what the edge pass (`composeEdgesAndLabels`)
 * answered, taken from the TypeScript before it was deleted (ADR-0054 step 7,
 * S18h) and frozen. The Rust port replays it exactly
 * (`tests/compose_edges_oracle.rs` in `crates/core/canvas-render`). This test
 * holds the recording to the outcomes it must reach.
 */
const FILE = new URL('./compose-edges.jsonl', import.meta.url)

const records = readFileSync(FILE, 'utf8')
  .trimEnd()
  .split('\n')
  .map((line) => JSON.parse(line) as ComposeEdgesRecord)

const cases = records.flatMap((r) => (r.kind === 'case' ? [r] : []))

describe('the recorded compose-edges oracle', () => {
  it('reaches every outcome the edge pass has', () => {
    expect(records[0]?.kind, 'the meta line first').toBe('meta')
    expect(cases.length, 'cases').toBeGreaterThan(100)
    const scenes = cases.map((c) => c.answer.scene)
    const has = (what: string, test: (scene: string) => boolean) =>
      expect(scenes.some(test), what).toBe(true)
    has('a label', (s) => s.includes('"annotates"'))
    has('a hop', (s) => s.includes('"jumps"'))
    has('a pencilled edge', (s) => s.includes('"sketch"'))
    has('a rounded route', (s) => s.includes('"rounded":true'))
    has('a weighed stroke', (s) => s.includes('"strokeWidth"'))
    has('a free end', (s) => s.includes('free ink'))
    expect(
      cases.some((c) => c.answer.jumps !== null && c.answer.jumps.length > 0),
      'jumps',
    ).toBe(true)
    expect(
      cases.some((c) => c.answer.anchors.some((a) => a.includes('around'))),
      'around',
    ).toBe(true)
  })
})
