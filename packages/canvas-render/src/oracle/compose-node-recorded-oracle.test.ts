import { readFileSync, writeFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  type ComposeNodeRecord,
  composeNodeRecords,
  reanswer,
} from '../test-utils/compose-node-oracle/oracle.js'

/**
 * The committed recording of what `composeNode` answers equals what it answers
 * today, and the Rust port replays it exactly (`tests/compose_node_oracle.rs` in
 * `crates/core/canvas-render`). Re-record after a deliberate change with
 * `WHITEBOARD_RECORD_ORACLE=1 pnpm vitest run --project canvas-render-node compose-node-recorded`.
 */
const FILE = new URL('./compose-node.jsonl', import.meta.url)

if (process.env.WHITEBOARD_RECORD_ORACLE === '1') {
  writeFileSync(
    FILE,
    `${composeNodeRecords()
      .map((r) => JSON.stringify(r))
      .join('\n')}\n`,
  )
}

const records = readFileSync(FILE, 'utf8')
  .trimEnd()
  .split('\n')
  .map((line) => JSON.parse(line) as ComposeNodeRecord)

const cases = records.flatMap((r) => (r.kind === 'case' ? [r] : []))

describe('the recorded compose-node oracle', () => {
  it('reaches every kind of node and every outcome', () => {
    expect(records[0]?.kind, 'the meta line first').toBe('meta')
    expect(cases.length, 'cases').toBeGreaterThan(150)
    const answers = cases.map((c) => c.answer)
    const has = (what: string, test: (a: (typeof answers)[number]) => boolean) =>
      expect(answers.some(test), what).toBe(true)
    has('a body that failed to parse', (a) => a.events.some((e) => e.kind === 'body-parse-failed'))
    has('a tiled background', (a) =>
      a.events.some((e) => e.kind === 'unsupported-background-style'),
    )
    has('an unclaimed resource', (a) => a.events.some((e) => e.detail === 'image/png'))
    has('a lock', (a) => a.scene.includes('"lock"'))
    has('a background', (a) => a.scene.includes('blob:bg'))
    has('a contained background', (a) => a.scene.includes('"contain"'))
    has('an empty frame tinted', (a) => a.scene.includes('"fillOpacity"'))
    has('a body kept in the cache', (a) => a.kept.length > 0)
    has('a body the spent budget kept out', (a) => a.asked.length > 0 && a.kept.length === 0)
    has('a placeholder for the budget', (a) => a.scene.includes('"budget"'))
    has('an embed laid out', (a) => a.scene.includes('Embedded'))
    has('a first line kept', (a) => a.scene.includes('"truncated":true'))
    has('a file drawn', (a) => a.scene.includes('Notes A'))
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
