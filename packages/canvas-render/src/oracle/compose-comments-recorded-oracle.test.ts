import { readFileSync, writeFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  type ComposeCommentsRecord,
  composeCommentsRecords,
} from '../test-utils/compose-comments-oracle/oracle.js'

/**
 * The committed recording of what the comment layer draws over a whole canvas
 * equals what it draws today, and the Rust port replays it exactly
 * (`tests/compose_canvas_support/comments.rs` in `crates/core/canvas-render`). Re-record
 * after a deliberate change with
 * `WHITEBOARD_RECORD_ORACLE=1 pnpm vitest run --project canvas-render-node compose-comments-recorded`.
 */
const FILE = new URL('./compose-comments.jsonl', import.meta.url)

const fresh = composeCommentsRecords()

if (process.env.WHITEBOARD_RECORD_ORACLE === '1') {
  writeFileSync(FILE, `${fresh.map((r) => JSON.stringify(r)).join('\n')}\n`)
}

const records = readFileSync(FILE, 'utf8')
  .trimEnd()
  .split('\n')
  .map((line) => JSON.parse(line) as ComposeCommentsRecord)

const cases = records.flatMap((r) => (r.kind === 'case' ? [r] : []))

describe('the recorded compose-comments oracle', () => {
  it('reaches every outcome the comment layer has', () => {
    expect(records[0]?.kind, 'the meta line first').toBe('meta')
    const scenes = cases.map((c) => c.answer.scene)
    const has = (what: string, needle: string) =>
      expect(
        scenes.some((s) => s.includes(needle)),
        what,
      ).toBe(true)
    has('a region outline', '"t-set/region"')
    has('a settled region outline', '"t-settled-region/region"')
    has('a pin', '"t-node/pin"')
    has('a settled pin', '"t-settled/pin"')
    has('a pin on a passage of a node', '"t-passage/pin"')
    has('a pin on an edge', '"on-ad/pin"')
    has('a pin on a curve', '"on-ab/pin"')
    for (const gone of ['t-note', 't-passage-gone', 't-doc']) {
      expect(
        scenes.some((s) => s.includes(`"${gone}/`)),
        `${gone} has no pin`,
      ).toBe(false)
    }
    expect(
      cases.some((c) => c.answer.pinCounts.length > 0),
      'a pin count',
    ).toBe(true)
    expect(
      cases.every((c) => Object.keys(c.answer.bodies).length > 0),
      'a body in every case',
    ).toBe(true)
  })

  it('equals what the TypeScript answers today', () => {
    const parted = records.findIndex((r, i) => JSON.stringify(fresh[i]) !== JSON.stringify(r))
    const record = records[parted]
    expect(
      record === undefined
        ? undefined
        : `${parted}: ${record.kind === 'case' ? record.id : 'meta'}`,
      'the first record the TypeScript no longer answers as recorded',
    ).toBeUndefined()
    expect(records.length).toBe(fresh.length)
  })
})
