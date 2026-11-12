import { readFileSync, writeFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { type FitRecord, fitRecords, reanswer } from '../test-utils/typeset-oracle/fit-oracle.js'
import { HAND_SCENES } from '../test-utils/typeset-oracle/fit-scenes.js'

/**
 * The committed recording of what `fitBlocksToHeight` and `firstLineOfBlocks`
 * keep of a laid-out body equals what they keep today, and the Rust port replays
 * it exactly (`tests/fit_oracle.rs` in `crates/core/canvas-render`). Re-record after
 * a deliberate change with
 * `WHITEBOARD_RECORD_ORACLE=1 pnpm vitest run --project canvas-render-node fit-recorded`.
 */
const FILE = new URL('./fit.jsonl', import.meta.url)

if (process.env.WHITEBOARD_RECORD_ORACLE === '1') {
  writeFileSync(
    FILE,
    `${fitRecords()
      .map((r) => JSON.stringify(r))
      .join('\n')}\n`,
  )
}

const records = readFileSync(FILE, 'utf8')
  .trimEnd()
  .split('\n')
  .map((line) => JSON.parse(line) as FitRecord)

describe('the recorded fit oracle', () => {
  it('reaches laid-out bodies, every kind of cut and the signals', () => {
    expect(records.length).toBeGreaterThan(200)
    const fits = records.flatMap((r) => r.fits)
    expect(fits.length, 'recorded heights').toBeGreaterThan(3000)
    expect(
      fits.some((f) => f.truncated),
      'a cut',
    ).toBe(true)
    expect(
      fits.some((f) => !f.truncated && !f.overflows),
      'an uncut body',
    ).toBe(true)
    expect(
      fits.some((f) => !f.truncated && f.overflows),
      'an overflow without a cut',
    ).toBe(true)
    expect(
      records.some((r) => r.id === 'hand-scene/table-then-text'),
      'the table case',
    ).toBe(true)
    expect(records.filter((r) => r.first.truncated).length, 'first lines cut').toBeGreaterThan(20)
  })

  it('holds every hand scene the corpus declares', () => {
    const recorded = new Set(records.map((r) => r.id))
    expect(HAND_SCENES.map(([id]) => id).filter((id) => !recorded.has(id))).toEqual([])
  })

  it('equals what the TypeScript keeps today', () => {
    const parted = records.findIndex((r) => JSON.stringify(reanswer(r)) !== JSON.stringify(r))
    expect(
      records[parted]?.id,
      'the first case the TypeScript no longer answers as recorded',
    ).toBeUndefined()
  })
})
