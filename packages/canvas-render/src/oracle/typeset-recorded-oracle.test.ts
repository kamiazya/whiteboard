import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  GENERATED_COUNT,
  GENERATED_SEED,
  typesetInputs,
} from '../test-utils/typeset-oracle/corpus.js'
import {
  type RecordMeta,
  type TypesetInput,
  type TypesetRecord,
  typesetAnswer,
} from '../test-utils/typeset-oracle/oracle.js'

/**
 * The committed recording of what `typesetMdastBlocks` answers for a paragraph
 * or a heading — the scene it lays out and how many times it asked the
 * measurer — equals what the TypeScript answers today, and the Rust typesetter
 * replays it exactly (`tests/typeset_oracle.rs` in `crates/core/canvas-render`).
 * The recording holds its inputs and the answers of the host seams, so the
 * freshness check reads no corpus. Re-record after a deliberate change with
 * `WHITEBOARD_RECORD_ORACLE=1 pnpm vitest run --project canvas-render-node typeset-recorded`.
 */
const FILE = new URL('./typeset.jsonl', import.meta.url)

if (process.env.WHITEBOARD_RECORD_ORACLE === '1') {
  const records = typesetInputs(true).map(typesetAnswer)
  const meta: RecordMeta = { kind: 'meta', seed: GENERATED_SEED, generated: GENERATED_COUNT }
  // The host's answers repeat across records (every tree that embeds a document carries that
  // document's tables), so each distinct set is written once and a record names it by key.
  const tables = new Map<string, unknown>()
  const keyed = records.map((record) => {
    const key = keyOf(record.seams)
    tables.set(key, record.seams)
    return { ...record, seams: key }
  })
  const sections = [...tables].map(([key, seams]) => ({ kind: 'seams', key, seams }))
  writeFileSync(FILE, `${[meta, ...sections, ...keyed].map((r) => JSON.stringify(r)).join('\n')}\n`)
}

function keyOf(seams: unknown): string {
  return createHash('sha256').update(JSON.stringify(seams)).digest('hex').slice(0, 24)
}

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

const asInput = ({
  id,
  root,
  width,
  theme,
  fill,
  embeds,
  syntax,
  digest,
}: TypesetRecord): TypesetInput => ({
  id,
  root,
  width,
  theme,
  fill,
  embeds,
  syntax,
  digest,
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

  it('equals what the TypeScript answers today', { timeout: 120_000 }, () => {
    const parted = records.findIndex(
      (r) => JSON.stringify(typesetAnswer(asInput(r))) !== JSON.stringify(r),
    )
    expect(
      records[parted]?.id,
      'the first recorded case the TypeScript no longer answers as recorded',
    ).toBeUndefined()
  })
})
