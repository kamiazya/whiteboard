import {
  deriveFacetForm,
  FACET_KEY_PATTERN,
  FACET_SEGMENT_PATTERN,
} from '@kamiazya/whiteboard-facet-engine'
import { TAG_IDENTIFIER_PATTERN } from '@kamiazya/whiteboard-model'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { visualStencilsFacetSchema } from './stencil-library.js'
import { tagLibrarySchema, visualTagsFacetSchema } from './tag-library.js'

// The tag and stencil libraries are generated from `contracts/facets/visual`.
// What a generated schema must keep is what a reader can observe of the
// hand-written one: which payloads parse and to what, the code, message,
// path and ORDER of every refusal, the JSON Schema `wb_facet_list` serves,
// and the form the facet panel derives.

type Issue = { code: string; message: string; path: PropertyKey[] }

const issuesOf = (schema: z.ZodTypeAny, value: unknown): Issue[] => {
  const result = schema.safeParse(value)
  return result.success
    ? []
    : result.error.issues.map(({ code, message, path }) => ({ code, message, path }))
}

const badKey = (...path: PropertyKey[]): Issue => ({
  code: 'invalid_key',
  message: 'Invalid key in record',
  path,
})
const notRecord = (received: string, ...path: PropertyKey[]): Issue => ({
  code: 'invalid_type',
  message: `Invalid input: expected record, received ${received}`,
  path,
})
const wrongType = (expected: string, received: string, ...path: PropertyKey[]): Issue => ({
  code: 'invalid_type',
  message: `Invalid input: expected ${expected}, received ${received}`,
  path,
})
const unrecognized = (keys: string, plural: boolean, ...path: PropertyKey[]): Issue => ({
  code: 'unrecognized_keys',
  message: `Unrecognized key${plural ? 's' : ''}: ${keys}`,
  path,
})
const DRAFT = '{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object",'

describe('visual.tags', () => {
  const schema = visualTagsFacetSchema
  const TAG_COLOUR_REFUSAL = 'must be a preset "1"–"6" or a 6-digit hex color such as "#1a2b3c"'

  it('takes keys with a description, exclusivity and admitted values, and strips the rest at the root', () => {
    const library = {
      health: {
        description: 'd',
        exclusive: true,
        values: { ok: { color: '4', description: 'x' }, bad: { color: '#ff0000' } },
      },
      empty: {},
    }
    expect(schema.parse({ keys: library, extra: 1 })).toEqual({ keys: library })
    expect(Object.keys(schema.parse({ keys: library }).keys)).toEqual(['health', 'empty'])
  })

  it('refuses a key or a value outside the identifier grammar, each at its own path', () => {
    expect(issuesOf(schema, { keys: { Health: {}, a_b: 1, ok: { values: { Bad: {} } } } })).toEqual(
      [badKey('keys', 'Health'), badKey('keys', 'a_b'), badKey('keys', 'ok', 'values', 'Bad')],
    )
  })

  it('refuses a colour with the model’s own sentence, or its union refusal for a non-string', () => {
    const at = (color: unknown) => issuesOf(schema, { keys: { a: { values: { b: { color } } } } })
    const path = ['keys', 'a', 'values', 'b', 'color']
    const hex = { code: 'invalid_format', message: TAG_COLOUR_REFUSAL, path }
    expect(at('7')).toEqual([hex])
    expect(at('#ff00')).toEqual([hex])
    expect(at(5)).toEqual([{ code: 'invalid_union', message: 'Invalid input', path }])
    expect(at('6')).toEqual([])
    expect(at('#1A2b3C')).toEqual([])
  })

  it('refuses a field it does not know on a key and on a value, after the fields it checked', () => {
    expect(
      issuesOf(schema, {
        keys: { ok: { values: { good: { color: '7', z: 1 } }, extra: 1 } },
      }),
    ).toEqual([
      {
        code: 'invalid_format',
        message: TAG_COLOUR_REFUSAL,
        path: ['keys', 'ok', 'values', 'good', 'color'],
      },
      unrecognized('"z"', false, 'keys', 'ok', 'values', 'good'),
      unrecognized('"extra"', false, 'keys', 'ok'),
    ])
  })

  it('reports a key’s fields in the order the key declares them', () => {
    expect(
      issuesOf(schema, { keys: { a: { exclusive: 'yes', description: 3, values: [] } } }),
    ).toEqual([
      wrongType('string', 'number', 'keys', 'a', 'description'),
      wrongType('boolean', 'string', 'keys', 'a', 'exclusive'),
      notRecord('array', 'keys', 'a', 'values'),
    ])
    expect(
      issuesOf(schema, { keys: { a: { values: { b: { color: 5, description: 1, z: 1 } } } } }),
    ).toEqual([
      {
        code: 'invalid_union',
        message: 'Invalid input',
        path: ['keys', 'a', 'values', 'b', 'color'],
      },
      wrongType('string', 'number', 'keys', 'a', 'values', 'b', 'description'),
      unrecognized('"z"', false, 'keys', 'a', 'values', 'b'),
    ])
  })

  it('refuses a payload without keys, with keys that are not a record, or that is not an object', () => {
    expect(issuesOf(schema, {})).toEqual([notRecord('undefined', 'keys')])
    expect(issuesOf(schema, { keys: [] })).toEqual([notRecord('array', 'keys')])
    expect(issuesOf(schema, null)).toEqual([wrongType('object', 'null')])
  })

  it('is the library the wire carries, without the wrapper', () => {
    expect(tagLibrarySchema.parse({ a: {} })).toEqual({ a: {} })
    expect(issuesOf(tagLibrarySchema, [])).toEqual([notRecord('array')])
    expect(issuesOf(tagLibrarySchema, { A: {} })).toEqual([badKey('A')])
    expect(tagLibrarySchema).toBe(visualTagsFacetSchema.shape.keys)
  })

  it('spells the model’s identifier grammar', () => {
    const json = z.toJSONSchema(schema) as {
      properties: { keys: { propertyNames: { pattern: string } } }
    }
    expect(json.properties.keys.propertyNames.pattern).toBe(TAG_IDENTIFIER_PATTERN.source)
  })

  it('publishes the JSON Schema wb_facet_list serves, byte for byte', () => {
    expect(JSON.stringify(z.toJSONSchema(schema))).toBe(
      `${DRAFT}"properties":{"keys":{"type":"object","propertyNames":{"type":"string","pattern":"^[a-z][a-z0-9-]*$"},"additionalProperties":{"type":"object","properties":{"description":{"type":"string"},"exclusive":{"type":"boolean"},"values":{"type":"object","propertyNames":{"type":"string","pattern":"^[a-z][a-z0-9-]*$"},"additionalProperties":{"type":"object","properties":{"color":{"$ref":"#/$defs/CanvasColor"},"description":{"type":"string"}},"additionalProperties":false}}},"additionalProperties":false}}},"required":["keys"],"additionalProperties":false,"$defs":{"CanvasColor":{"anyOf":[{"type":"string","enum":["1","2","3","4","5","6"]},{"type":"string","pattern":"^#[0-9a-fA-F]{6}$"}]}}}`,
    )
  })

  it('derives no form, because a library is authored as a document', () => {
    expect(deriveFacetForm(schema)).toEqual({ kind: 'unsupported' })
  })
})

describe('visual.stencils', () => {
  const schema = visualStencilsFacetSchema
  const STENCIL_COLOUR_REFUSAL = 'must be a preset "1" to "6" or a 6-digit hex color like "#ff0000"'
  const sized = (count: number, entry: () => unknown) =>
    Object.fromEntries(Array.from({ length: count }, (_, i) => [`s${i}`, entry()]))
  const COUNT = (n: number): Issue => ({
    code: 'custom',
    message: `a stencil library holds at most 256 stencils; this one has ${n}`,
    path: ['stencils'],
  })

  it('takes a vocabulary, fills an absent facets with an empty record and strips the rest at the root', () => {
    const parsed = schema.parse({
      stencils: {
        bucket: {
          displayName: 'B',
          color: '5',
          facets: { 'visual.shape/v0': { kind: 'cylinder' } },
        },
        x: { displayName: 'X' },
      },
      extra: 1,
    })
    expect(parsed).toEqual({
      stencils: {
        bucket: {
          displayName: 'B',
          color: '5',
          facets: { 'visual.shape/v0': { kind: 'cylinder' } },
        },
        x: { displayName: 'X', facets: {} },
      },
    })
    expect(Object.keys(parsed.stencils)).toEqual(['bucket', 'x'])
  })

  it('refuses, in order, a name, a colour, a facet key and the fields a stencil may not carry', () => {
    expect(
      issuesOf(schema, {
        stencils: {
          Bucket: { displayName: '' },
          ok: { displayName: 'a', color: 'red', facets: { bad: 1 }, x: 1, text: 't' },
          'a b': { color: '#12345' },
        },
      }),
    ).toEqual([
      badKey('stencils', 'Bucket'),
      { code: 'custom', message: STENCIL_COLOUR_REFUSAL, path: ['stencils', 'ok', 'color'] },
      badKey('stencils', 'ok', 'facets', 'bad'),
      unrecognized('"x", "text"', true, 'stencils', 'ok'),
      badKey('stencils', 'a b'),
    ])
  })

  it('judges a colour by the model after the string checks, and a non-string by the string check alone', () => {
    const at = (color: unknown) =>
      issuesOf(schema, { stencils: { a: { displayName: 'a', color } } })
    const path = ['stencils', 'a', 'color']
    expect(at('')).toEqual([
      { code: 'too_small', message: 'Too small: expected string to have >=1 characters', path },
      { code: 'custom', message: STENCIL_COLOUR_REFUSAL, path },
    ])
    expect(at(3)).toEqual([wrongType('string', 'number', ...path)])
    expect(at('7')).toEqual([{ code: 'custom', message: STENCIL_COLOUR_REFUSAL, path }])
    expect(at('1')).toEqual([])
    expect(at('#ABCDEF')).toEqual([])
  })

  it('refuses a payload without stencils, an entry that is not an object, or facets that are not a record', () => {
    expect(issuesOf(schema, {})).toEqual([notRecord('undefined', 'stencils')])
    expect(issuesOf(schema, { stencils: [] })).toEqual([notRecord('array', 'stencils')])
    expect(issuesOf(schema, { stencils: { a: 3 } })).toEqual([
      wrongType('object', 'number', 'stencils', 'a'),
    ])
    expect(issuesOf(schema, { stencils: { a: { displayName: 'a', facets: [] } } })).toEqual([
      notRecord('array', 'stencils', 'a', 'facets'),
    ])
    expect(issuesOf(schema, null)).toEqual([wrongType('object', 'null')])
  })

  it('holds a library of exactly the cap and refuses one past it by its count alone', () => {
    expect(issuesOf(schema, { stencils: sized(256, () => ({ displayName: 'a' })) })).toEqual([])
    expect(issuesOf(schema, { stencils: sized(257, () => ({ displayName: 'a' })) })).toEqual([
      COUNT(257),
    ])
    expect(issuesOf(schema, { stencils: sized(300, () => ({})) })).toEqual([COUNT(300)])
    const badNames = Object.fromEntries(Array.from({ length: 257 }, (_, i) => [`B${i}`, {}]))
    expect(issuesOf(schema, { stencils: badNames })).toEqual([COUNT(257)])
  })

  it('keeps the record the server-core tool defaults', () => {
    const stencils = schema.shape.stencils.default({})
    expect(stencils.parse(undefined)).toEqual({})
    expect(issuesOf(stencils, { Bad: { displayName: 'a' } })).toEqual([badKey('Bad')])
  })

  it('spells the engine’s grammars, which the generated schema cannot import', () => {
    const json = z.toJSONSchema(schema) as {
      properties: {
        stencils: {
          propertyNames: { pattern: string }
          additionalProperties: {
            properties: { facets: { propertyNames: { pattern: string } } }
          }
        }
      }
    }
    const { stencils } = json.properties
    expect(stencils.propertyNames.pattern).toBe(FACET_SEGMENT_PATTERN.source)
    expect(stencils.additionalProperties.properties.facets.propertyNames.pattern).toBe(
      FACET_KEY_PATTERN.source,
    )
  })

  it('publishes the JSON Schema wb_facet_list serves, for what it returns and for what it takes', () => {
    expect(JSON.stringify(z.toJSONSchema(schema))).toBe(
      `${DRAFT}"properties":{"stencils":{"type":"object","propertyNames":{"type":"string","pattern":"^[a-z][a-z0-9-]*$"},"additionalProperties":{"type":"object","properties":{"displayName":{"type":"string","minLength":1},"color":{"type":"string","minLength":1},"facets":{"default":{},"type":"object","propertyNames":{"type":"string","pattern":"^[a-z][a-z0-9-]*\\\\.[a-z][a-z0-9-]*\\\\/v[0-9]+$"},"additionalProperties":{}}},"required":["displayName","facets"],"additionalProperties":false}}},"required":["stencils"],"additionalProperties":false}`,
    )
    expect(JSON.stringify(z.toJSONSchema(schema, { io: 'input' }))).toBe(
      `${DRAFT}"properties":{"stencils":{"type":"object","propertyNames":{"type":"string"},"additionalProperties":{}}},"required":["stencils"]}`,
    )
  })

  it('derives no form, because a library is authored as a document', () => {
    expect(deriveFacetForm(schema)).toEqual({ kind: 'unsupported' })
  })
})
