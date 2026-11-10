import { readFileSync, writeFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  answerAgain,
  caseOf,
  type RecordedCase,
  recordInputs,
  SCHEMAS,
} from '../test-utils/contract-schemas-oracle.js'

/**
 * The committed recording of the engine contract's asset schemas and the
 * plugin manifest, as their generated Zod answers them, equals what Zod
 * answers today. The Rust interpreter of the same contract files replays it
 * (`crates/core/facet-engine/tests/schema_oracle.rs`) and is held to the
 * path and the code of every issue, in order; the message is not recorded.
 *
 * The recording holds the inputs as well as the answers, so this test draws
 * nothing. Re-record after a deliberate change to a contract with
 * `WHITEBOARD_RECORD_ORACLE=1 pnpm vitest run --project facet-engine-node contract-schemas-recorded`.
 */
const FILE = new URL('./contract-schemas.jsonl', import.meta.url)

if (process.env.WHITEBOARD_RECORD_ORACLE === '1') {
  const cases = recordInputs().map(([name, input]) => caseOf(name, input))
  writeFileSync(FILE, `${cases.map((line) => JSON.stringify(line)).join('\n')}\n`)
}

describe('the recorded contract schema oracle', () => {
  const recorded = readFileSync(FILE, 'utf8')
    .trimEnd()
    .split('\n')
    .map((line) => JSON.parse(line) as RecordedCase)

  it('reaches every schema both ways and the constructs the contracts use', () => {
    expect(recorded.length, 'recorded cases').toBeGreaterThan(700)
    for (const name of Object.keys(SCHEMAS)) {
      const mine = recorded.filter((line) => line.s === name)
      expect(mine.filter((line) => 'ok' in line).length, `${name} accepted`).toBeGreaterThan(20)
      expect(mine.filter((line) => 'err' in line).length, `${name} refused`).toBeGreaterThan(50)
    }
    const text = JSON.stringify(recorded.filter((line) => 'err' in line))
    for (const code of [
      'invalid_type',
      'too_small',
      'invalid_format',
      'invalid_value',
      'unrecognized_keys',
      'invalid_union',
      'invalid_key',
    ]) {
      expect(text, code).toContain(`,"${code}",`)
    }
    const filled = recorded.filter(
      (line) =>
        line.s === 'ThemeTokens' &&
        'ok' in line &&
        JSON.stringify(line.ok).includes('"defaults"') &&
        !JSON.stringify(line.in).includes('"defaults"'),
    )
    expect(filled.length, 'themes whose defaults the schema filled in').toBeGreaterThan(2)
  })

  it('equals what the generated Zod answers today', () => {
    const parted = recorded.findIndex(
      (line) => JSON.stringify(answerAgain(line)) !== JSON.stringify(line),
    )
    expect(parted, 'the first recorded case Zod no longer answers as recorded').toBe(-1)
  })
})
