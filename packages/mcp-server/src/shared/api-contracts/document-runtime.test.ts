import { describe, expect, it } from 'vitest'
import {
  clientCountResponseSchema,
  viewportErrorBodySchema,
  viewportResponseSchema,
} from './document-runtime.js'

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
  // Every route branch is pinned here so the schema keeps matching what the
  // sole producer (server/routes/viewport.ts) actually sends.
  it('accepts the no_client body (hint present)', () => {
    const input = { error: 'no_client', message: 'No browser connected', hint: 'Open the canvas' }
    expect(viewportErrorBodySchema.parse(input)).toEqual(input)
  })

  it('accepts the timeout/internal bodies (no hint)', () => {
    const input = { error: 'timeout', message: 'Viewport update timed out after 5s.' }
    expect(viewportErrorBodySchema.parse(input)).toEqual(input)
  })

  it('rejects a body missing error or message — no producer emits one', () => {
    expect(() => viewportErrorBodySchema.parse({})).toThrow()
    expect(() => viewportErrorBodySchema.parse({ error: 'timeout' })).toThrow()
    expect(() => viewportErrorBodySchema.parse({ message: 'lonely message' })).toThrow()
  })

  it('rejects non-string error', () => {
    expect(() => viewportErrorBodySchema.parse({ error: 42, message: 'x' })).toThrow()
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
