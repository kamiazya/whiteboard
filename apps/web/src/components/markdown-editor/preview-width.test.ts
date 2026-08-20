import { describe, expect, it } from 'vitest'
import {
  PREVIEW_COLUMN_PADDING_PX,
  previewWidth,
  RAIL_MIN_CONTAINER_WIDTH_PX,
  RAIL_WIDTH_PX,
  railFits,
} from './preview-width.js'

const read = (containerWidth: number, railWidth = RAIL_WIDTH_PX) =>
  previewWidth({ containerWidth, maxWidth: 720, railWidth, splitRatio: 0.5, mode: 'read' })

describe('the preview column never asks for more width than the pane has', () => {
  // The reported defect, in its own numbers: a 390px phone with the rail on
  // typeset at 320 inside a 334px pane, so the column (320 + 48) overflowed
  // by 34px and the editor drew a horizontal scrollbar under the text.
  it('fits a phone', () => {
    expect(read(390) + PREVIEW_COLUMN_PADDING_PX).toBeLessThanOrEqual(390 - RAIL_WIDTH_PX)
  })

  it('fits at every width from a tiny pane up to a desktop', () => {
    for (let width = 200; width <= 1600; width += 1) {
      const railWidth = railFits(width) ? RAIL_WIDTH_PX : 0
      const column = read(width, railWidth) + PREVIEW_COLUMN_PADDING_PX
      expect(column).toBeLessThanOrEqual(width - railWidth)
    }
  })

  it('rounds DOWN, so quantisation alone cannot overshoot the edge', () => {
    // available = 300 rounds to 320 at nearest, which overflows on its own.
    expect(read(300 + PREVIEW_COLUMN_PADDING_PX, 0)).toBeLessThanOrEqual(300)
  })

  it('still grants the preferred measure once there is room for it', () => {
    expect(read(1200)).toBeGreaterThanOrEqual(320)
  })

  it('caps at maxWidth on a wide screen rather than sprawling', () => {
    expect(read(2400)).toBe(720)
  })
})

describe('the rail is affordable only beside a document at its measure', () => {
  it('is hidden on a phone and shown on a desktop', () => {
    expect(railFits(390)).toBe(false)
    expect(railFits(1200)).toBe(true)
  })

  it('turns on exactly where the document can still have its measure', () => {
    expect(railFits(RAIL_MIN_CONTAINER_WIDTH_PX - 1)).toBe(false)
    expect(railFits(RAIL_MIN_CONTAINER_WIDTH_PX)).toBe(true)
  })

  it('stays hidden until the container has been measured, so it never flashes in and out', () => {
    expect(railFits(null)).toBe(false)
  })
})
