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
    const nested = cases.flatMap((c) => c.answer.nested ?? [])
    expect(nested.length, 'nested layouts').toBeGreaterThan(5)
    const deeper = (n: (typeof nested)[number]) => n.depth > 1 && n.path.length > 0
    expect(nested.some(deeper), 'a nested layout below the top').toBe(true)
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
    has('a file drawn as its picture', (a) => a.scene.includes('blob:pic'))
    has('a file drawn as its body', (a) => a.scene.includes('referenced document'))
    has('a file drawn as its card', (a) => a.scene.includes('Spec'))
    has('a card that fell back from an empty body', (a) => a.scene.includes('Fallback card'))
    has('a card row the trim keeps', (a) => a.scene.includes('\u0085'))
    has('a file drawn as its canvas', (a) => a.scene.includes('"embedResolved"'))
    has('a canvas the spent budget refused', (a) => a.scene.includes('Board notes'))
    has('a file whose subpath follows its name', (a) => a.scene.includes('Doc MD#Heading'))
    has('a body drawing a canvas', (a) => a.scene.includes('"inside"') && a.scene.includes('Over'))
    has(
      'a canvas spent before a fit with no room',
      (a) => a.scene.includes('"budget"') && !a.scene.includes('"embedResolved"'),
    )
    has('a canvas the element account refused', (a) => a.scene.includes('Board E'))
    const badges = records.flatMap((r) => (r.kind === 'decoration' ? [r] : []))
    expect(badges.filter((d) => d.scene.includes('"icon"')).length, 'badges drawn').toBeGreaterThan(
      5,
    )
    expect(
      badges.filter((d) => d.stencil !== null && !d.scene.includes('"icon"')).length,
    ).toBeGreaterThan(5)
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
