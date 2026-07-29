import { describe, expect, it } from 'vitest'
import { z } from 'zod'

const viewportResponseSchema = z.object({
  ok: z.literal(true),
})

const viewportErrorBodySchema = z.object({
  error: z.string().optional(),
  message: z.string().optional(),
  hint: z.string().optional(),
})

const clientCountResponseSchema = z.object({
  count: z.number().int().nonnegative(),
  readyCount: z.number().int().nonnegative(),
})

describe('viewportResponseSchema', () => {
  it('accepts { ok: true }', () => {
    expect(viewportResponseSchema.parse({ ok: true })).toEqual({ ok: true })
  })

  it('rejects ok: false', () => {
    expect(() => viewportResponseSchema.parse({ ok: false })).toThrow()
  })

  it('rejects missing ok', () => {
    expect(() => viewportResponseSchema.parse({})).toThrow()
  })
})

describe('viewportErrorBodySchema', () => {
  it('accepts all fields present', () => {
    const input = { error: 'no_client', message: 'No browser connected', hint: 'Open the canvas' }
    expect(viewportErrorBodySchema.parse(input)).toEqual(input)
  })

  it('accepts empty object (all fields optional)', () => {
    expect(viewportErrorBodySchema.parse({})).toEqual({})
  })

  it('rejects non-string error', () => {
    expect(() => viewportErrorBodySchema.parse({ error: 42 })).toThrow()
  })
})

describe('clientCountResponseSchema', () => {
  it('accepts zero counts', () => {
    const input = { count: 0, readyCount: 0 }
    expect(clientCountResponseSchema.parse(input)).toEqual(input)
  })

  it('accepts positive counts', () => {
    const input = { count: 3, readyCount: 2 }
    expect(clientCountResponseSchema.parse(input)).toEqual(input)
  })

  it('rejects negative count', () => {
    expect(() => clientCountResponseSchema.parse({ count: -1, readyCount: 0 })).toThrow()
  })

  it('rejects non-integer count', () => {
    expect(() => clientCountResponseSchema.parse({ count: 1.5, readyCount: 0 })).toThrow()
  })

  it('rejects missing readyCount', () => {
    expect(() => clientCountResponseSchema.parse({ count: 1 })).toThrow()
  })
})
