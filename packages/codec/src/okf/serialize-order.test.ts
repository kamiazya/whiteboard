import { describe, expect, it } from 'vitest'
import { fc, fcTest } from '../test-utils/fast-check.js'
import { serializeOkf } from './okf-core.js'
import type { OkfMarkdownDocument } from './schema.js'

/**
 * A frontmatter is written with its root keys in the order the caller built
 * it: the core writes the order the wire carries rather than declining one that
 * is not the schema's, so a caller's spread order moves no byte. The one
 * exception is the buckets that are written where they were spread FROM:
 * `facetsRaw`'s keys at the root, after the named keys, and `facets` last.
 */

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

/** The root keys the writer put at column zero, in the order it wrote them. */
const writtenRootKeys = (written: string): string[] =>
  [...written.matchAll(/^([A-Za-z]+):/gm)].map((match) => match[1] as string)

/** The order the writer is held to: the named keys as built, then facetsRaw's keys, then facets. */
const expectedRootKeys = (names: readonly string[]): string[] => [
  ...names.filter((name) => name !== 'facets' && name !== 'facetsRaw'),
  ...(names.includes('facetsRaw') ? ['unknown'] : []),
  ...(names.includes('facets') ? ['facets'] : []),
]

/** The known root keys of a document, any subset, in any order, `type` among them. */
const shuffledKeys = fc
  .tuple(fc.shuffledSubarray(SCHEMA_ORDER.slice(1)), fc.nat())
  .map(([optional, at]) => {
    const place = at % (optional.length + 1)
    return [...optional.slice(0, place), 'type', ...optional.slice(place)]
  })

describe('serializeOkf through the Rust core', () => {
  it('keeps the order a caller spreads title in', () => {
    const written = serializeOkf(build(['type', 'description', 'tags', 'title', 'facets']))
    expect(writtenRootKeys(written)).toEqual(['type', 'description', 'tags', 'title', 'facets'])
  })

  fcTest.prop([shuffledKeys])('writes root keys in the order they were built', (names) => {
    expect(writtenRootKeys(serializeOkf(build(names)))).toEqual(expectedRootKeys(names))
  })

  it('draws orders other than the schema one', () => {
    const orders = fc.sample(shuffledKeys, 200)
    const inSchemaOrder = orders.filter(
      (names) => names.join() === SCHEMA_ORDER.filter((n) => names.includes(n)).join(),
    )
    expect(orders.length - inSchemaOrder.length).toBeGreaterThan(100)
  })
})
