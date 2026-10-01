import { describe, expect, it } from 'vitest'
import { clientCountResponseSchema } from './document-runtime.js'

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
