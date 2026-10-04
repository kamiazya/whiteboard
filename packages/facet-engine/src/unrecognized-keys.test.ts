import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createFacetRegistry, defineFacet, definePlugin } from './registry.js'
import { describeUnrecognizedKey, firstUnrecognizedKey } from './unrecognized-keys.js'

const schema = z.object({
  box: z.object({ size: z.number() }),
  rows: z.array(z.object({ id: z.string() })),
  free: z.record(z.string(), z.number()),
  note: z.string().optional(),
})
const valid = { box: { size: 1 }, rows: [{ id: 'a' }], free: { anything: 2 } }

const strayOf = (sent: unknown) => firstUnrecognizedKey(sent, schema.parse(sent))

describe('firstUnrecognizedKey', () => {
  it('finds nothing in a payload the schema kept whole', () => {
    expect(strayOf(valid)).toBeUndefined()
  })

  it('names a key stripped from the payload itself', () => {
    const stray = strayOf({ ...valid, bogus: 1 })
    expect(stray).toEqual({ path: [], key: 'bogus' })
    expect(describeUnrecognizedKey(stray as never)).toBe('payload: Unrecognized key: "bogus"')
  })

  it('names a key stripped from a nested object, with the path to it', () => {
    const stray = strayOf({ ...valid, box: { size: 1, x: 1 } })
    expect(describeUnrecognizedKey(stray as never)).toBe('box: Unrecognized key: "x"')
  })

  it('names a key stripped from an object inside an array, by index', () => {
    const stray = strayOf({ ...valid, rows: [{ id: 'a' }, { id: 'b', y: 1 }] })
    expect(describeUnrecognizedKey(stray as never)).toBe('rows.1: Unrecognized key: "y"')
  })

  it('never reports the keys of a record, whose schema keeps every one', () => {
    expect(strayOf({ ...valid, free: { a: 1, b: 2, c: 3 } })).toBeUndefined()
  })

  it('ignores an undeclared key whose value is undefined, which says nothing a payload could keep', () => {
    expect(strayOf({ ...valid, bogus: undefined })).toBeUndefined()
  })
})

describe('validateFacetWrite and a key the schema does not declare', () => {
  // The editor's derived form relies on this: its draft still holds the
  // previous variant's field, and it stores what the schema kept. Strictness
  // belongs to the writers that ask `firstUnrecognizedKey`, not to this.
  it('answers the parsed value, without the key', () => {
    const registry = createFacetRegistry([
      definePlugin({
        id: 'example',
        displayName: 'Example',
        facets: [
          defineFacet({
            name: 'sample',
            displayName: 'Sample',
            version: 'v0',
            targets: ['document'],
            schema: z.object({ status: z.string() }),
          }),
        ],
      }),
    ])
    expect(registry.validateFacetWrite('example.sample/v0', { status: 'open', bogus: 1 })).toEqual({
      ok: true,
      value: { status: 'open' },
    })
  })
})
