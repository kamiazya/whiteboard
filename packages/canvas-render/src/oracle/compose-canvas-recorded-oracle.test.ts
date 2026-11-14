import { readFileSync, writeFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  type ComposeCanvasRecord,
  composeCanvasRecords,
} from '../test-utils/compose-canvas-oracle/oracle.js'

/**
 * The committed recording of what the composer's walk over a whole canvas
 * answers equals what it answers today, and the Rust port replays it exactly
 * (`tests/compose_canvas_oracle.rs` in `crates/core/canvas-render`). Re-record
 * after a deliberate change with
 * `WHITEBOARD_RECORD_ORACLE=1 pnpm vitest run --project canvas-render-node compose-canvas-recorded`.
 */
const FILE = new URL('./compose-canvas.jsonl', import.meta.url)

const fresh = composeCanvasRecords()

if (process.env.WHITEBOARD_RECORD_ORACLE === '1') {
  writeFileSync(FILE, `${fresh.map((r) => JSON.stringify(r)).join('\n')}\n`)
}

const records = readFileSync(FILE, 'utf8')
  .trimEnd()
  .split('\n')
  .map((line) => JSON.parse(line) as ComposeCanvasRecord)

const cases = records.flatMap((r) => (r.kind === 'case' ? [r] : []))

describe('the recorded compose-canvas oracle', () => {
  it('reaches every outcome the walk has', () => {
    expect(records[0]?.kind, 'the meta line first').toBe('meta')
    const events = cases.flatMap((c) => c.answer.canvas.events.map((e) => e.kind))
    expect(events, 'an unknown theme').toContain('unknown-theme')
    expect(events, 'a missing face').toContain('font-missing')
    const scenes = cases.map((c) => c.answer.canvas.scene)
    const has = (what: string, test: (scene: string) => boolean) =>
      expect(scenes.some(test), what).toBe(true)
    has('a lock badge', (s) => s.includes('"lock"'))
    has('a pencilled shape', (s) => s.includes('"sketch"'))
    has('a declared colour', (s) => s.includes('#12ab34'))
    has('a file drawn as its canvas', (s) => s.includes('"documentId":"boards/plain.canvas"'))
    has('a body drawing a canvas', (s) => s.includes('"documentId":"01HZX3Q8K9V2M4N5P6R7S8T9WC"'))
    has('a canvas three embeds down', (s) => s.includes('level 3'))
    has(
      'a canvas past the depth cap left a card',
      (s) => !s.includes('level 4') && s.includes('deep-4'),
    )
    expect(
      cases.some((c) => c.answer.canvas.legend !== null),
      'a legend',
    ).toBe(true)
    expect(
      cases.every((c) => c.answer.canvas.overlay.nodes.length === 0),
      'no overlay node: the comment layer is the compose-comments recording, and no board proposes',
    ).toBe(true)
    expect(
      cases.some((c) => c.answer.natural.some(([, w]) => w !== '0000000000000000')),
      'a natural size',
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
