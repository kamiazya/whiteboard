import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createFacetRegistry, defineFacet, definePlugin } from './registry.js'

const samplePlugin = definePlugin({
  id: 'example',
  displayName: 'Example',
  facets: [
    defineFacet({
      name: 'sample',
      version: 'v0',
      targets: ['document'],
      schema: z.object({ status: z.string().min(1) }),
    }),
  ],
})

describe('defineFacet / definePlugin', () => {
  it('rejects an invalid facet name segment at definition time', () => {
    expect(() =>
      defineFacet({ name: 'Bad Name', version: 'v0', targets: ['document'], schema: z.object({}) }),
    ).toThrow(/name/)
  })

  it('rejects an invalid version tag at definition time', () => {
    expect(() =>
      defineFacet({
        name: 'ok',
        version: '1' as never,
        targets: ['document'],
        schema: z.object({}),
      }),
    ).toThrow(/version/)
  })

  it('rejects an empty targets list', () => {
    expect(() =>
      defineFacet({ name: 'ok', version: 'v0', targets: [], schema: z.object({}) }),
    ).toThrow(/targets/)
  })

  it('rejects an invalid plugin id segment', () => {
    expect(() => definePlugin({ id: 'Not OK', displayName: 'Not OK', facets: [] })).toThrow(/id/)
  })

  it('rejects two facets with the same name inside one plugin', () => {
    const twice = defineFacet({
      name: 'sample',
      version: 'v0',
      targets: ['document'],
      schema: z.object({}),
    })
    expect(() =>
      definePlugin({ id: 'example', displayName: 'Example', facets: [twice, twice] }),
    ).toThrow(/duplicate/)
  })
})

describe('createFacetRegistry', () => {
  it('throws on a duplicate plugin id — collision governance is per plugin', () => {
    expect(() => createFacetRegistry([samplePlugin, samplePlugin])).toThrow(/example/)
  })

  it('answers targets for a registered key and undefined for an unknown one', () => {
    const registry = createFacetRegistry([samplePlugin])
    expect(registry.targetsOf('example.sample/v0')).toEqual(['document'])
    expect(registry.targetsOf('other.sample/v0')).toBeUndefined()
  })
})

describe('validateFacetWrite', () => {
  const registry = createFacetRegistry([samplePlugin])

  it('accepts a registered facet with a valid payload', () => {
    const result = registry.validateFacetWrite('example.sample/v0', { status: 'open' })
    expect(result).toEqual({ ok: true, value: { status: 'open' } })
  })

  it('rejects a registered facet with an invalid payload', () => {
    const result = registry.validateFacetWrite('example.sample/v0', { status: 1 })
    expect(result.ok).toBe(false)
  })

  it('passes an unregistered facet through unvalidated (round-trip safety)', () => {
    const payload = { anything: ['goes'] }
    expect(registry.validateFacetWrite('someone.else/v3', payload)).toEqual({
      ok: true,
      value: payload,
    })
  })

  it('rejects a write to a registered facet under a non-current version key', () => {
    // Writes always target the current version (ADR-0013 decision 7); the
    // error names the key the caller should have used.
    const result = registry.validateFacetWrite('example.sample/v4', { status: 'open' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toContain('example.sample/v0')
  })
})

describe('resolveFacetPayload', () => {
  // A three-version facet: v0 {a:number} -> v1 {b:string} -> v2 {c:string}.
  const chained = definePlugin({
    id: 'chain',
    displayName: 'Chain',
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
  })
  const registry = createFacetRegistry([chained])

  it('resolves a current-version payload through the current schema', () => {
    expect(registry.resolveFacetPayload('chain.thing/v2', { c: 'x' })).toEqual({
      kind: 'resolved',
      value: { c: 'x' },
    })
  })

  it('drops a current-version payload the schema rejects', () => {
    expect(registry.resolveFacetPayload('chain.thing/v2', { c: 1 })).toEqual({ kind: 'dropped' })
  })

  it('migrates an oldest-version payload stepwise to the current shape', () => {
    expect(registry.resolveFacetPayload('chain.thing/v0', { a: 7 })).toEqual({
      kind: 'resolved',
      value: { c: 'c:7' },
    })
  })

  it('drops an old payload its retained schema rejects', () => {
    expect(registry.resolveFacetPayload('chain.thing/v0', { a: 'seven' })).toEqual({
      kind: 'dropped',
    })
  })

  it('drops an older version with no compat entry', () => {
    const gapped = createFacetRegistry([
      definePlugin({
        id: 'gap',
        displayName: 'Gap',
        facets: [
          defineFacet({
            name: 'thing',
            version: 'v2',
            targets: ['document'],
            schema: z.object({ c: z.string() }),
          }),
        ],
      }),
    ])
    expect(gapped.resolveFacetPayload('gap.thing/v0', { a: 1 })).toEqual({ kind: 'dropped' })
  })

  it('preserves (does not resolve, does not drop) a version newer than registered', () => {
    const payload = { future: true }
    expect(registry.resolveFacetPayload('chain.thing/v9', payload)).toEqual({
      kind: 'preserved',
      payload,
    })
  })

  it('passes an unknown facet through untouched', () => {
    const payload = { keep: 'me' }
    expect(registry.resolveFacetPayload('someone.else/v1', payload)).toEqual({
      kind: 'passthrough',
      payload,
    })
  })
})

describe('malformed keys — every registry method has an explicit branch', () => {
  const registry = createFacetRegistry([samplePlugin])
  const malformed = ['not a key', 'example.sample', 'example/v0', 'Example.sample/v0']

  it.each(malformed)('targetsOf answers undefined for %s', (key) => {
    expect(registry.targetsOf(key)).toBeUndefined()
  })

  it.each(malformed)('validateFacetWrite rejects %s, naming the malformation', (key) => {
    const result = registry.validateFacetWrite(key, {})
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toContain('malformed')
  })

  // Dropped, NOT passthrough: a malformed stored key is unreadable data the
  // drop-not-fail read rule skips — passing it through would launder it.
  it.each(malformed)('resolveFacetPayload drops %s', (key) => {
    expect(registry.resolveFacetPayload(key, {})).toEqual({ kind: 'dropped' })
  })
})
