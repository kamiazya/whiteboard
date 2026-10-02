import { describe, expect, it } from 'vitest'
import { frontierSchema } from './frontier.js'

describe('frontierSchema', () => {
  it('accepts a non-empty Uint8Array', () => {
    expect(frontierSchema.safeParse(new Uint8Array([1, 2, 3])).success).toBe(true)
  })

  it('accepts an empty Uint8Array (an empty/new doc has an empty frontier)', () => {
    expect(frontierSchema.safeParse(new Uint8Array()).success).toBe(true)
  })

  it('rejects a plain array', () => {
    expect(frontierSchema.safeParse([1, 2, 3]).success).toBe(false)
  })

  it('rejects a string', () => {
    expect(frontierSchema.safeParse('abc').success).toBe(false)
  })

  it('rejects an ArrayBuffer (not a typed-array view)', () => {
    expect(frontierSchema.safeParse(new ArrayBuffer(3)).success).toBe(false)
  })

  it('rejects null and undefined', () => {
    expect(frontierSchema.safeParse(null).success).toBe(false)
    expect(frontierSchema.safeParse(undefined).success).toBe(false)
  })
})
