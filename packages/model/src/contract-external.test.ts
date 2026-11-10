import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import * as facets from './facets.js'
import { okfActorSchema, okfTimestampSchema } from './generated/okf.zod.js'
import * as ids from './ids.js'
import * as nodeResource from './node-resource.js'

// A definition marked `x-wb-external` has its Zod half written by hand, because
// a schema cannot state its refinement, while its Rust type is generated from
// the shape the contract gives it. Nothing generates the hand-written half from
// that shape, so this is what holds the two to each other: same kind, same
// bounds, same keys, same required set.

interface Def {
  readonly type?: string
  readonly pattern?: string
  readonly properties?: Record<string, { type?: string; 'x-wb-minUtf16'?: number }>
  readonly required?: readonly string[]
  readonly additionalProperties?: boolean | object
  readonly 'x-wb-minUtf16'?: number
  readonly 'x-wb-message'?: string
  readonly 'x-wb-external'?: string
}

const contract = JSON.parse(
  readFileSync(new URL('../../../contracts/model/spatial.schema.json', import.meta.url), 'utf8'),
) as { $defs: Record<string, Def> }

// The module each external definition is imported from, as the contract spells it.
const MODULES: Record<string, Record<string, unknown>> = {
  '../ids.js': ids,
  '../facets.js': facets,
  '../node-resource.js': nodeResource,
  './okf.zod.js': { okfActorSchema, okfTimestampSchema },
}

const schemaName = (def: string) => `${def.charAt(0).toLowerCase()}${def.slice(1)}Schema`
const externals = Object.entries(contract.$defs).filter(([, def]) => def['x-wb-external'])

describe('the hand-written half of an external definition', () => {
  it('is found: the contract declares externals and each module exports its schema', () => {
    expect(externals.map(([name]) => name)).toEqual(
      expect.arrayContaining(['NodeId', 'DocumentId', 'ExtensionFacets', 'NodeResource']),
    )
    for (const [name, def] of externals) {
      const module = MODULES[def['x-wb-external'] ?? '']
      expect(
        module,
        `${name}: ${def['x-wb-external']} is not a module this test knows`,
      ).toBeDefined()
      expect(module?.[schemaName(name)], `${name}`).toBeInstanceOf(z.ZodType)
    }
  })

  it('has the kind, length bound and pattern the contract gives a string', () => {
    for (const [name, def] of externals.filter(([, d]) => d.type === 'string')) {
      const schema = MODULES[def['x-wb-external'] ?? '']?.[schemaName(name)] as z.ZodType
      const published = z.toJSONSchema(schema, { io: 'input' })
      expect(published.type, name).toBe('string')
      expect(published.minLength, name).toBe(def['x-wb-minUtf16'])
      expect(published.pattern, name).toBe(def.pattern)
    }
  })

  it('refuses a malformed pattern string with the contract message', () => {
    const message = contract.$defs.DocumentId?.['x-wb-message']
    const result = ids.documentIdSchema.safeParse('not-a-ulid')
    expect(result.error?.issues[0]?.message).toBe(message)
    expect(okfTimestampSchema.safeParse('2026-01-01').error?.issues[0]?.message).toBe(
      contract.$defs.OkfTimestamp?.['x-wb-message'],
    )
  })

  it('has the keys, required set and strictness the contract gives an object', () => {
    for (const [name, def] of externals.filter(([, d]) => d.properties)) {
      const schema = MODULES[def['x-wb-external'] ?? '']?.[schemaName(name)] as z.ZodType
      const published = z.toJSONSchema(schema, { io: 'input' })
      expect(Object.keys(published.properties ?? {}).sort(), name).toEqual(
        Object.keys(def.properties ?? {}).sort(),
      )
      expect([...(published.required ?? [])].sort(), name).toEqual([...(def.required ?? [])].sort())
      expect(published.additionalProperties, name).toBe(def.additionalProperties)
    }
  })

  it('is a record of anything for an extension facet bucket', () => {
    const published = z.toJSONSchema(facets.extensionFacetsSchema, { io: 'input' })
    expect(published.$defs?.ExtensionFacets).toMatchObject({ type: 'object' })
    expect(contract.$defs.ExtensionFacets?.type).toBe('object')
  })
})
