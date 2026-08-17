import { describe, expect, it } from 'vitest'
import { presenceStateSchema } from './presence.js'

describe('presenceStateSchema', () => {
  it('accepts peerId alone', () => {
    expect(presenceStateSchema.safeParse({ peerId: 'peer-1' }).success).toBe(true)
  })

  it('accepts peerId with cursor and selection', () => {
    const result = presenceStateSchema.safeParse({
      peerId: 'peer-1',
      cursor: { x: 1.5, y: -2 },
      selection: ['node-a', 'node-b'],
    })
    expect(result.success).toBe(true)
  })

  it('rejects a missing or empty peerId', () => {
    expect(presenceStateSchema.safeParse({}).success).toBe(false)
    expect(presenceStateSchema.safeParse({ peerId: '' }).success).toBe(false)
  })

  it('rejects a cursor missing x or y', () => {
    expect(presenceStateSchema.safeParse({ peerId: 'peer-1', cursor: { x: 1 } }).success).toBe(
      false,
    )
    expect(presenceStateSchema.safeParse({ peerId: 'peer-1', cursor: { y: 1 } }).success).toBe(
      false,
    )
  })

  it('rejects a selection containing an empty node id', () => {
    expect(presenceStateSchema.safeParse({ peerId: 'peer-1', selection: [''] }).success).toBe(false)
  })

  it('rejects an extra unknown key (strict)', () => {
    expect(presenceStateSchema.safeParse({ peerId: 'peer-1', extra: 1 }).success).toBe(false)
    expect(
      presenceStateSchema.safeParse({ peerId: 'peer-1', cursor: { x: 1, y: 2, z: 3 } }).success,
    ).toBe(false)
  })
})
