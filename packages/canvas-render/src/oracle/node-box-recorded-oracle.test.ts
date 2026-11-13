import { readFileSync, writeFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  type NodeBoxRecord,
  nodeBoxRecords,
  reanswer,
} from '../test-utils/node-box-oracle/oracle.js'

/**
 * The committed recording of what the node-box primitives answer equals what they
 * answer today, and the Rust port replays it exactly (`tests/node_box_oracle.rs` in
 * `crates/core/canvas-render`). Re-record after a deliberate change with
 * `WHITEBOARD_RECORD_ORACLE=1 pnpm vitest run --project canvas-render-node node-box-recorded`.
 */
const FILE = new URL('./node-box.jsonl', import.meta.url)

if (process.env.WHITEBOARD_RECORD_ORACLE === '1') {
  writeFileSync(
    FILE,
    `${nodeBoxRecords()
      .map((r) => JSON.stringify(r))
      .join('\n')}\n`,
  )
}

const records = readFileSync(FILE, 'utf8')
  .trimEnd()
  .split('\n')
  .map((line) => JSON.parse(line) as NodeBoxRecord)

const cases = records.flatMap((r) => (r.kind === 'case' ? [r] : []))

describe('the recorded node-box oracle', () => {
  it('reaches every kind of node, silhouette, theme and outcome', () => {
    expect(records[0]?.kind, 'the meta line first').toBe('meta')
    expect(cases.length, 'cases').toBeGreaterThan(300)
    expect(records.filter((r) => r.kind === 'translate').length, 'translations').toBeGreaterThan(50)
    const answers = cases.map((c) => c.answer)
    expect(
      answers.some((a) => a.fit === null),
      'a box too small to fit anything',
    ).toBe(true)
    expect(
      answers.some((a) => a.fit?.truncated === true),
      'a cut',
    ).toBe(true)
    expect(
      answers.some((a) => a.fit?.truncated === false),
      'an uncut fit',
    ).toBe(true)
    expect(
      answers.some((a) => a.probe.includes('"truncated":true')),
      'a cut label',
    ).toBe(true)
    expect(
      answers.some((a) => a.probe.includes('"overflows":true')),
      'an overflowing label',
    ).toBe(true)
    expect(
      answers.some((a) => a.chrome.includes('"hatch"')),
      'a hatched chrome',
    ).toBe(true)
    expect(
      answers.some((a) => a.label === 'Missing reference'),
      'a missing file',
    ).toBe(true)
    expect(
      answers.some((a) => a.label === 'Image'),
      'an unnamed image',
    ).toBe(true)
    expect(
      answers.some((a) => a.label?.endsWith('#Part two') === true),
      'a subpath',
    ).toBe(true)
    for (const shape of ['visual.ellipse', 'visual.cylinder', 'visual.star', null])
      expect(
        cases.some((c) => c.shape === shape && c.fitToBox),
        `${shape} fitted`,
      ).toBe(true)
    for (const align of ['start', 'center', null])
      expect(
        cases.some((c) => c.align === align && c.shape !== null),
        `${align} shaped`,
      ).toBe(true)
  })

  it('equals what the TypeScript answers today', () => {
    const parted = records.findIndex((r) => JSON.stringify(reanswer(r)) !== JSON.stringify(r))
    const record = records[parted]
    expect(
      record === undefined ? undefined : `${parted}: ${record.kind}`,
      'the first record the TypeScript no longer answers as recorded',
    ).toBeUndefined()
  })
})
