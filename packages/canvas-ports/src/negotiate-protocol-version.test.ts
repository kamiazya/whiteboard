import { describe, expect, it } from 'vitest'
import { negotiateProtocolVersion } from './sync-protocol.js'

describe('negotiateProtocolVersion', () => {
  it('returns the max common version when versions overlap', () => {
    expect(negotiateProtocolVersion([1, 2, 3], [2, 3, 4])).toBe(3)
  })

  it('returns null for disjoint version sets', () => {
    expect(negotiateProtocolVersion([1], [2])).toBeNull()
  })

  it('returns null for an empty client version list', () => {
    expect(negotiateProtocolVersion([], [1, 2])).toBeNull()
  })

  it('returns null for an empty server version list', () => {
    expect(negotiateProtocolVersion([1, 2], [])).toBeNull()
  })

  it('returns the single common version', () => {
    expect(negotiateProtocolVersion([1, 2], [2])).toBe(2)
  })

  it('is order-independent', () => {
    expect(negotiateProtocolVersion([3, 1, 2], [4, 2, 3])).toBe(
      negotiateProtocolVersion([1, 2, 3], [2, 3, 4]),
    )
  })
})
