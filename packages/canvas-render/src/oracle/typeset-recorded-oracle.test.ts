import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { RecordMeta, TypesetRecord } from '../test-utils/typeset-oracle/oracle.js'

/**
 * The committed recording of what `typesetMdastBlocks` answered for a
 * paragraph or a heading — the scene it laid out and how many times it asked
 * the measurer — taken from the TypeScript before it was deleted (ADR-0054
 * step 7, S18h) and frozen. The Rust typesetter replays it exactly
 * (`tests/typeset_oracle.rs` in `crates/core/canvas-render`). The recording
 * holds its inputs and the answers of the host seams; this test holds it to
 * the kinds of input it must reach.
 */
const FILE = new URL('./typeset.jsonl', import.meta.url)

/** The generated trees' seed and count as the recording was drawn: its provenance, not a property seed. */
const GENERATED_SEED = 0x7e57_5e7a
const GENERATED_COUNT = 600

const lines = readFileSync(FILE, 'utf8').trimEnd().split('\n')
const parsed = lines.slice(1).map((line) => JSON.parse(line) as { kind?: string; key?: string })
const tables = new Map(
  parsed.flatMap((line) =>
    line.kind === 'seams'
      ? [[line.key, (line as unknown as { seams: unknown }).seams] as const]
      : [],
  ),
)
/** A record as it was answered, its seams read back from the table it names. */
const records = parsed
  .filter((line) => line.kind !== 'seams')
  .map((line) => {
    const named = line as unknown as { seams: string }
    return { ...named, seams: tables.get(named.seams) } as unknown as TypesetRecord
  })

describe('the recorded typeset oracle', () => {
  it('reaches every kind of input the Rust typesetter is held to', () => {
    const meta = JSON.parse(lines[0] ?? '{}') as RecordMeta
    expect(meta.seed).toBe(GENERATED_SEED)
    expect(meta.generated, 'generated trees, less those that cut a pair').toBeGreaterThan(
      GENERATED_COUNT - 40,
    )
    const under = (prefix: string) => records.filter((r) => r.id.startsWith(prefix)).length
    expect(under('hand/'), 'hand-written cases').toBeGreaterThan(300)
    expect(under('wrap/'), 'wrapping corpus cases').toBeGreaterThan(30)
    expect(under('blocks/'), 'childless blocks').toBeGreaterThan(300)
    expect(under('containers/'), 'quotes, lists and tables').toBeGreaterThan(150)
    expect(under('doc/'), 'whole documents').toBeGreaterThan(300)
    expect(under('embeds/'), 'embeds').toBeGreaterThan(300)
    expect(under('gen/'), 'generated trees').toBe(meta.generated)
    expect(under('md/'), 'parsed corpus blocks').toBeGreaterThan(1000)
    expect(new Set(records.map((r) => r.theme)).size, 'themes').toBe(3)
    const held = records
      .filter((r) => 'scene' in r)
      .map((r) => (r as { scene: string }).scene)
      .join('\n')
    for (const kind of [
      'paragraph',
      'heading',
      'textRun',
      'codeBlock',
      'thematicBreak',
      'rawHtml',
      'unresolvedReference',
      'svgFragment',
      'blockquote',
      'list',
      'listItem',
      'table',
      'tableRow',
      'tableCell',
      'edge',
      'shape',
      'embedResolved',
      'embedPlaceholder',
    ])
      expect(held.includes(`"kind":"${kind}"`), `a scene holding a ${kind}`).toBe(true)
    for (const reason of ['cycle', 'depthCap', 'budget', 'unresolvable'])
      expect(held.includes(`"reason":"${reason}"`), `an embed placeholder for ${reason}`).toBe(true)
    expect(
      records.some((r) => r.embedPath !== undefined),
      'a body laid out inside documents the host names',
    ).toBe(true)
    for (const key of [
      'truncated',
      'overflows',
      'backdropPadXPx',
      'paints',
      'link',
      'taskBox',
      'ordinal',
      'header',
    ])
      expect(held.includes(`"${key}":`), `a run carrying ${key}`).toBe(true)
  })
})
