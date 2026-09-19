import { describe, expect, it } from 'vitest'
import {
  continuesStroke,
  type PreviousStroke,
  STROKE_GROUP_PAUSE_MS,
  strokeBounds,
} from './stroke-group.js'

const previous: PreviousStroke = {
  group: 'g1',
  endedAt: 1_000,
  bounds: { minX: 0, minY: 0, maxX: 100, maxY: 100 },
}

describe('strokeBounds', () => {
  it('is the box the points occupy', () => {
    expect(
      strokeBounds([
        { x: 10, y: 40 },
        { x: -5, y: 90 },
        { x: 60, y: 0 },
      ]),
    ).toEqual({ minX: -5, minY: 0, maxX: 60, maxY: 90 })
  })

  it('is nothing for no points', () => {
    expect(strokeBounds([])).toBeUndefined()
  })
})

describe('continuesStroke', () => {
  it('continues a stroke the hand barely left', () => {
    expect(continuesStroke(previous, 1_100, { x: 110, y: 50 }, 1)).toBe(true)
  })

  it('starts afresh after a pause, however near it lands', () => {
    // A stroke in the same place a minute later is a correction, not the
    // next stroke of the same character.
    expect(continuesStroke(previous, 1_000 + STROKE_GROUP_PAUSE_MS + 1, { x: 50, y: 50 }, 1)).toBe(
      false,
    )
  })

  it('starts afresh across the board, however quickly it follows', () => {
    // And a stroke an instant later somewhere else is a different mark made
    // quickly. Both conditions, because either alone is wrong.
    expect(continuesStroke(previous, 1_010, { x: 900, y: 900 }, 1)).toBe(false)
  })

  it('measures the gap in SCREEN pixels, so zoom cannot redefine "near"', () => {
    // The same DOCUMENT distance, and the direction is the one that reads
    // backwards until you picture it: drawn at a quarter size, a gap of 100
    // document units is 25 pixels on the display — near — while at zoom 1 it
    // is 100 pixels and plainly a separate mark. What the hand judges is
    // what it sees.
    const apart = { x: 200, y: 50 }
    expect(continuesStroke(previous, 1_100, apart, 1)).toBe(false)
    expect(continuesStroke(previous, 1_100, apart, 0.25)).toBe(true)
  })

  it('continues nothing when there is no previous stroke', () => {
    expect(continuesStroke(undefined, 1_100, { x: 0, y: 0 }, 1)).toBe(false)
  })

  it('refuses a press that reads as arriving before the last release', () => {
    // A clock nobody can trust — a restored session, a paused tab, two
    // pointers. No continuation beats an instant one.
    expect(continuesStroke(previous, 900, { x: 50, y: 50 }, 1)).toBe(false)
  })
})
