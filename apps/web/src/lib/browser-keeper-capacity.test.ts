import { describe, expect, it } from 'vitest'
import {
  browserKeeperCapacity,
  capacityState,
  DESKTOP_CAPACITY,
  MOBILE_CAPACITY,
  WorkspaceCapacityReachedError,
} from './browser-keeper-capacity.js'

describe('capacityState', () => {
  const capacity = { bandStartsAt: 3, limit: 5 }

  it('is room below the band, band from its start, full at the limit', () => {
    expect([0, 2, 3, 4, 5, 9].map((count) => capacityState(count, capacity))).toEqual([
      'room',
      'room',
      'band',
      'band',
      'full',
      'full',
    ])
  })
})

describe('browserKeeperCapacity', () => {
  it('holds a desktop to the desktop capacity', () => {
    expect(browserKeeperCapacity({ coarsePointer: false, deviceMemoryGb: 16 })).toBe(
      DESKTOP_CAPACITY,
    )
  })

  it('holds a touch-first device to the mobile capacity', () => {
    expect(browserKeeperCapacity({ coarsePointer: true, deviceMemoryGb: 8 })).toBe(MOBILE_CAPACITY)
  })

  it('holds a device reporting little memory to the mobile capacity', () => {
    expect(browserKeeperCapacity({ coarsePointer: false, deviceMemoryGb: 4 })).toBe(MOBILE_CAPACITY)
  })

  it('does not read an unreported memory size as little memory', () => {
    expect(browserKeeperCapacity({ coarsePointer: false, deviceMemoryGb: undefined })).toBe(
      DESKTOP_CAPACITY,
    )
  })

  it('opens the band before the limit on both tiers', () => {
    for (const tier of [DESKTOP_CAPACITY, MOBILE_CAPACITY]) {
      expect(tier.bandStartsAt).toBeLessThan(tier.limit)
    }
  })
})

describe('WorkspaceCapacityReachedError', () => {
  it('says what was reached and where the workspace can go', () => {
    const err = new WorkspaceCapacityReachedError(500)
    expect(err.message).toMatch(/500 documents/)
    expect(err.message).toMatch(/Settings/)
  })
})
