import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createFacetRegistry, defineFacet, definePlugin } from './registry.js'

const samplePlugin = definePlugin({
  id: 'example',
  displayName: 'Example',
  facets: [
    defineFacet({
      name: 'sample',
      displayName: 'Sample',
      version: 'v0',
      targets: ['document'],
      schema: z.object({ status: z.string().min(1) }),
    }),
  ],
})

describe('defineFacet / definePlugin', () => {
  it('rejects an invalid facet name segment at definition time', () => {
    expect(() =>
      defineFacet({
        name: 'Bad Name',
        displayName: 'Bad',
        version: 'v0',
        targets: ['document'],
        schema: z.object({}),
      }),
    ).toThrow(/name/)
  })

  it('rejects an invalid version tag at definition time', () => {
    expect(() =>
      defineFacet({
        name: 'ok',
        displayName: 'Ok',
        version: '1' as never,
        targets: ['document'],
        schema: z.object({}),
      }),
    ).toThrow(/version/)
  })

  it('rejects an empty targets list', () => {
    expect(() =>
      defineFacet({
        name: 'ok',
        displayName: 'Ok',
        version: 'v0',
        targets: [],
        schema: z.object({}),
      }),
    ).toThrow(/targets/)
  })

  it('rejects an invalid plugin id segment', () => {
    expect(() => definePlugin({ id: 'Not OK', displayName: 'Not OK', facets: [] })).toThrow(/id/)
  })

  it('rejects two facets with the same name inside one plugin', () => {
    const twice = defineFacet({
      name: 'sample',
      displayName: 'Sample',
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
        displayName: 'Thing',
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
            displayName: 'Thing',
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

describe('write rejection messages are for a reader, not a dump', () => {
  const union = definePlugin({
    id: 'shapes',
    displayName: 'Shapes',
    facets: [
      defineFacet({
        name: 'badge',
        displayName: 'Badge',
        version: 'v0',
        targets: ['node'],
        schema: z.union([
          z.object({ kind: z.literal('icon'), name: z.string().min(1) }),
          z.object({ kind: z.literal('emoji'), char: z.string().min(1) }),
        ]),
      }),
    ],
  })
  const registry = createFacetRegistry([union])

  it('names each offending field and what it expected, on one line per issue', () => {
    const result = registry.validateFacetWrite('shapes.badge/v0', { kind: 'image', href: 'x' })
    expect(result.ok).toBe(false)
    const message = result.ok ? '' : result.message
    // No raw ZodError JSON: no bracket-dump, no internal issue codes.
    expect(message).not.toContain('"code"')
    expect(message).not.toContain('invalid_union')
    expect(message.split('\n')).toHaveLength(1)
    // The reader learns which field and which values are acceptable.
    expect(message).toContain('kind')
    expect(message).toContain('icon')
    expect(message).toContain('emoji')
  })

  it('a single-issue rejection stays short too', () => {
    const result = registry.validateFacetWrite('shapes.badge/v0', { kind: 'icon', name: '' })
    expect(result.ok).toBe(false)
    const message = result.ok ? '' : result.message
    expect(message).not.toContain('"code"')
    expect(message).toContain('name')
  })
})

describe('a facet carries its own human name', () => {
  const base = {
    version: 'v0' as const,
    targets: ['node' as const],
    schema: z.object({ a: z.string() }),
  }

  it('rejects a blank displayName, the way a plugin already is', () => {
    expect(() => defineFacet({ ...base, name: 'thing', displayName: '  ' })).toThrow(
      /needs a non-blank displayName/,
    )
  })

  it('keeps the name it was given', () => {
    // The panel used to build a title by concatenating the plugin's name
    // with this identifier ("Visual style shape"). A facet that says what
    // it is called ends that, and ends it for every later reader too.
    expect(defineFacet({ ...base, name: 'text', displayName: 'Text placement' }).displayName).toBe(
      'Text placement',
    )
  })
})
