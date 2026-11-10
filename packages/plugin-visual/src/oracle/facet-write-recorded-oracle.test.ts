import { readFileSync, writeFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { bundledFacetRegistry } from '../data.js'
import { answerAgain, type RecordedLine, recordLines } from '../test-utils/facet-write-oracle.js'

/**
 * The committed recording of the bundled registry's write path equals what
 * the TypeScript answers today. The Rust registry replays that recording
 * (`crates/core/plugin-visual/tests/facet_write_oracle.rs`), holding its
 * refusals to Zod's in the path and the code of every issue, in order, and
 * its accepted values to Zod's output; the message text is not recorded.
 *
 * The recording holds the inputs as well as the answers, so this test draws
 * nothing: it asks today's registry each recorded question again. Re-record
 * after a deliberate change to a facet's schema with
 * `WHITEBOARD_RECORD_ORACLE=1 pnpm vitest run --project plugin-visual-node facet-write-recorded`.
 */
const FILE = new URL('./facet-write.jsonl', import.meta.url)

if (process.env.WHITEBOARD_RECORD_ORACLE === '1') {
  const lines = recordLines(bundledFacetRegistry)
  writeFileSync(FILE, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`)
}

describe('the recorded facet write oracle', () => {
  const recorded = readFileSync(FILE, 'utf8')
    .trimEnd()
    .split('\n')
    .map((line) => JSON.parse(line) as RecordedLine)
  const writes = recorded.filter((line) => line.k === 'w')
  const stageOf = (line: RecordedLine) => ('err' in line ? line.err.stage : 'ok')

  it('reaches every stage, every facet both ways, and every issue code', () => {
    expect(writes.length, 'recorded writes').toBeGreaterThan(2000)
    for (const stage of ['ok', 'key', 'version', 'schema', 'asset']) {
      expect(writes.filter((line) => stageOf(line) === stage).length, stage).toBeGreaterThan(5)
    }
    const keys = bundledFacetRegistry.plugins.flatMap((plugin) =>
      plugin.facets.map((facet) => `${plugin.id}.${facet.name}/${facet.version}`),
    )
    expect(keys.length).toBe(11)
    for (const key of keys) {
      const mine = writes.filter((line) => line.k === 'w' && line.key === key)
      expect(
        mine.filter((line) => stageOf(line) === 'ok').length,
        `${key} accepted`,
      ).toBeGreaterThan(20)
      expect(
        mine.filter((line) => stageOf(line) === 'schema').length,
        `${key} refused`,
      ).toBeGreaterThan(20)
    }
    const text = JSON.stringify(writes)
    for (const code of [
      'invalid_type',
      'too_small',
      'too_big',
      'invalid_format',
      'invalid_value',
      'unrecognized_keys',
      'invalid_union',
      'invalid_key',
      'custom',
    ]) {
      expect(text, code).toContain(`,"${code}",`)
    }
  })

  it('reaches both outcomes of a union and a write that changes its payload', () => {
    const text = JSON.stringify(writes)
    expect(text, 'a union that named no single arm').toContain('"arms":[[[')
    const collapsed = writes.filter(
      (line) =>
        line.k === 'w' &&
        line.key === 'visual.symbol/v0' &&
        'err' in line &&
        line.err.stage === 'schema' &&
        line.err.issues.every(([, code]) => code !== 'invalid_union'),
    )
    expect(collapsed.length, 'a union collapsed to the one arm that nearly fit').toBeGreaterThan(3)
    const changed = writes.filter(
      (line) =>
        line.k === 'w' && 'ok' in line && JSON.stringify(line.ok) !== JSON.stringify(line.in),
    )
    expect(changed.length, 'writes whose output differs from the input').toBeGreaterThan(20)
  })

  it('equals what the registry answers today', () => {
    const parted = recorded.findIndex(
      (line) => JSON.stringify(answerAgain(bundledFacetRegistry, line)) !== JSON.stringify(line),
    )
    expect(parted, 'the first recorded line the registry no longer answers as recorded').toBe(-1)
  })
})
