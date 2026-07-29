import { describe, expect, it } from 'vitest'
import {
  coreFacetsSchema,
  extensionFacetsSchema,
  facetsRawSchema,
  issueFacetPayloadSchema,
  RESERVED_ROOT_KEYS,
} from './facets.js'

describe('coreFacetsSchema', () => {
  it('accepts the minimal shape with only type', () => {
    expect(coreFacetsSchema.safeParse({ type: 'note' }).success).toBe(true)
  })

  it('accepts the full shape with title, tags, and view', () => {
    const result = coreFacetsSchema.safeParse({
      type: 'note',
      title: 'My note',
      tags: ['a', 'b'],
      view: 'kanban/1',
    })
    expect(result.success).toBe(true)
  })

  it('rejects a missing type', () => {
    expect(coreFacetsSchema.safeParse({}).success).toBe(false)
  })

  it('rejects an empty type', () => {
    expect(coreFacetsSchema.safeParse({ type: '' }).success).toBe(false)
  })

  it('rejects tags that are not an array of strings', () => {
    expect(coreFacetsSchema.safeParse({ type: 'note', tags: 'a' }).success).toBe(false)
    expect(coreFacetsSchema.safeParse({ type: 'note', tags: [1] }).success).toBe(false)
  })
})

describe('extensionFacetsSchema', () => {
  it('accepts a well-formed {domain}/{version} key and preserves the payload verbatim', () => {
    const payload = { kanban: { columns: ['todo', 'done'] } }
    const result = extensionFacetsSchema.safeParse({ 'kanban/1': payload.kanban })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data['kanban/1']).toEqual(payload.kanban)
    }
  })

  it.each([
    'kanban',
    'kanban/',
    'Kanban/1',
    'kanban/v1',
    '/1',
    'kanban//1',
  ])('rejects (not silently drops) a malformed key %s', (badKey) => {
    const result = extensionFacetsSchema.safeParse({ [badKey]: {} })
    expect(result.success).toBe(false)
  })

  it('accepts an empty record', () => {
    expect(extensionFacetsSchema.safeParse({}).success).toBe(true)
  })
})

describe('issueFacetPayloadSchema', () => {
  it('accepts the minimal shape with only status', () => {
    expect(issueFacetPayloadSchema.safeParse({ status: 'open' }).success).toBe(true)
  })

  it('accepts the full shape with all optional fields populated', () => {
    const result = issueFacetPayloadSchema.safeParse({
      status: 'in-progress',
      priority: 'high',
      assignees: ['alice', 'bob'],
      labels: ['bug', 'urgent'],
      due: '2026-08-01T00:00:00.000Z',
      summary: 'Fix the thing',
    })
    expect(result.success).toBe(true)
  })

  it('rejects a missing status', () => {
    expect(issueFacetPayloadSchema.safeParse({}).success).toBe(false)
  })

  it('rejects an invalid due date format', () => {
    expect(issueFacetPayloadSchema.safeParse({ status: 'open', due: 'not-a-date' }).success).toBe(
      false,
    )
  })

  it('rejects assignees that are not a string array', () => {
    expect(issueFacetPayloadSchema.safeParse({ status: 'open', assignees: [1, 2] }).success).toBe(
      false,
    )
    expect(issueFacetPayloadSchema.safeParse({ status: 'open', assignees: 'alice' }).success).toBe(
      false,
    )
  })

  it('rejects extra unknown keys', () => {
    expect(issueFacetPayloadSchema.safeParse({ status: 'open', extra: 'nope' }).success).toBe(false)
  })
})

describe('facetsRawSchema', () => {
  it('preserves arbitrary non-reserved root keys verbatim', () => {
    const result = facetsRawSchema.safeParse({ someFutureKey: { nested: 1 } })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.someFutureKey).toEqual({ nested: 1 })
    }
  })

  it.each(RESERVED_ROOT_KEYS)('rejects the reserved root key %s', (reservedKey) => {
    const result = facetsRawSchema.safeParse({ [reservedKey]: 'anything' })
    expect(result.success).toBe(false)
  })

  it('accepts an empty record', () => {
    expect(facetsRawSchema.safeParse({}).success).toBe(true)
  })
})
