import { describe, expect, it } from 'vitest'
import { pointSchema, rectSchema } from './generated/geometry.zod.js'

// The same refusals `crates/core/edge-routing/tests/geometry_contract.rs`
// pins on the Rust side: both halves are generated from one contract.
describe('the generated geometry contract', () => {
  it('parses a rect within bounds', () => {
    expect(rectSchema.parse({ x: -1, y: 2, w: 0, h: 3.5 })).toEqual({ x: -1, y: 2, w: 0, h: 3.5 })
  })

  it('refuses a negative size', () => {
    expect(rectSchema.safeParse({ x: 0, y: 0, w: -0.5, h: 1 }).success).toBe(false)
  })

  it('refuses an unknown key on both types', () => {
    expect(rectSchema.safeParse({ x: 0, y: 0, w: 1, h: 1, z: 0 }).success).toBe(false)
    expect(pointSchema.safeParse({ x: 0, y: 0, z: 0 }).success).toBe(false)
  })

  it('refuses a missing field', () => {
    expect(pointSchema.safeParse({ x: 0 }).success).toBe(false)
  })
})
