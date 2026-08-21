import { test } from '@fast-check/vitest'
import * as fc from 'fast-check'
import { describe, expect } from 'vitest'
import { z } from 'zod'
import { createFacetRegistry, defineFacet, definePlugin } from './registry.js'

// A three-version facet whose migrations are injective, so the property can
// assert the exact expected output rather than mere schema validity:
// v0 {a:number} --(b=String(a))--> v1 {b:string} --(c="c:"+b)--> v2 {c:string}.
const registry = createFacetRegistry([
  definePlugin({
    id: 'chain',
    facets: [
      defineFacet({
        name: 'thing',
        version: 'v2',
        targets: ['document'],
        schema: z.object({ c: z.string() }),
        compat: {
          v0: {
            schema: z.object({ a: z.number() }),
            migrate: (old) => ({ b: String((old as { a: number }).a) }),
          },
          v1: {
            schema: z.object({ b: z.string() }),
            migrate: (old) => ({ c: `c:${(old as { b: string }).b}` }),
          },
        },
      }),
    ],
  }),
])

describe('compat chain resolution', () => {
  test.prop([fc.integer()])(
    'any v0 payload resolves through every step to the exact v2 value',
    (a) => {
      expect(registry.resolveFacetPayload('chain.thing/v0', { a })).toEqual({
        kind: 'resolved',
        value: { c: `c:${a}` },
      })
    },
  )

  test.prop([fc.string()])('any v1 payload resolves through the remaining step', (b) => {
    expect(registry.resolveFacetPayload('chain.thing/v1', { b })).toEqual({
      kind: 'resolved',
      value: { c: `c:${b}` },
    })
  })

  test.prop([fc.string()])('a current-version payload resolves to itself', (c) => {
    expect(registry.resolveFacetPayload('chain.thing/v2', { c })).toEqual({
      kind: 'resolved',
      value: { c },
    })
  })
})
