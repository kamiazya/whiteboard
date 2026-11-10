import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { Core } from '@kamiazya/whiteboard-core-wasm'
import { loadCore } from '@kamiazya/whiteboard-core-wasm/load'
import { beforeAll, describe, expect, it } from 'vitest'
import { fc, fcTest } from '../test-utils/fast-check.js'
import { type OkfMismatch, okfCodec } from './okf-core.js'
import type { OkfMarkdownDocument } from './schema.js'
import { serializeOkf as serializeOkfTs } from './serialize.js'

/**
 * A frontmatter is written with its root keys in the order the caller built
 * it, by either implementation: the Rust core writes the order the wire
 * carries rather than declining one that is not the schema's, so a caller's
 * spread order neither moves a byte nor hands the write to the TypeScript.
 */
const artifact = fileURLToPath(import.meta.resolve('@kamiazya/whiteboard-core-wasm/wasm'))
let core: Core
beforeAll(async () => {
  core = await loadCore(readFileSync(artifact))
})

// Spelled out, not read from the schema, so the oracle shares nothing with the code it judges.
const SCHEMA_ORDER = [
  'type',
  'title',
  'description',
  'resource',
  'tags',
  'view',
  'generated',
  'verified',
  'facets',
  'facetsRaw',
] as const

const VALUES: Record<(typeof SCHEMA_ORDER)[number], unknown> = {
  type: 'note',
  title: 'A title',
  description: 'about it',
  resource: 'https://example.com/a',
  tags: ['x', 'y'],
  view: 'list',
  generated: { by: 'agent', at: '2026-01-01T00:00:00Z' },
  verified: [{ by: 'me', at: '2026-01-02T00:00:00Z' }],
  facets: { 'a.b/v1': { n: 'v' } },
  facetsRaw: { unknown: 'kept' },
}

const build = (names: readonly string[]): OkfMarkdownDocument => ({
  frontmatter: Object.fromEntries(
    names.map((name) => [name, VALUES[name as keyof typeof VALUES]]),
  ) as OkfMarkdownDocument['frontmatter'],
  body: 'body\n',
})

/** The known root keys of a document, any subset, in any order, `type` among them. */
const shuffledKeys = fc
  .tuple(fc.shuffledSubarray(SCHEMA_ORDER.slice(1)), fc.nat())
  .map(([optional, at]) => {
    const place = at % (optional.length + 1)
    return [...optional.slice(0, place), 'type', ...optional.slice(place)]
  })

function overCore() {
  const reports: OkfMismatch[] = []
  const codec = okfCodec({
    okf: core,
    impl: { parseOkf: 'rust', serializeOkf: 'rust' },
    onMismatch: (m) => reports.push(m),
  })
  return { codec, reports }
}

describe('serializeOkf through the Rust core', () => {
  it('keeps the order a caller spreads title in', () => {
    const { codec, reports } = overCore()
    const doc = build(['type', 'description', 'tags', 'title', 'facets'])
    const written = codec.serializeOkf(doc)
    expect(written).toBe(serializeOkfTs(doc))
    expect(written.indexOf('title:')).toBeGreaterThan(written.indexOf('tags:'))
    expect(reports).toEqual([])
  })

  fcTest.prop([shuffledKeys])('writes root keys in any order as the TypeScript does', (names) => {
    const { codec, reports } = overCore()
    const doc = build(names)
    expect(codec.serializeOkf(doc)).toBe(serializeOkfTs(doc))
    expect(reports).toEqual([])
  })

  it('writes the TypeScript the caller order too', () => {
    const doc = build(['type', 'tags', 'title'])
    const written = okfCodec(undefined).serializeOkf(doc)
    expect(written).toBe(serializeOkfTs(doc))
    expect(written.indexOf('title:')).toBeGreaterThan(written.indexOf('tags:'))
  })

  it('draws orders other than the schema one', () => {
    const orders = fc.sample(shuffledKeys, 200)
    const inSchemaOrder = orders.filter(
      (names) => names.join() === SCHEMA_ORDER.filter((n) => names.includes(n)).join(),
    )
    expect(orders.length - inSchemaOrder.length).toBeGreaterThan(100)
  })
})
