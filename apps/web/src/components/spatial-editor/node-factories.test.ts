// @vitest-environment node
import { SPATIAL_THEME_GEOMETRY } from '@kamiazya/whiteboard-canvas-render'
import { describe, expect, it } from 'vitest'
import { NEW_NODE_WIDTH } from './gestures.js'
import {
  DOCUMENT_NODE_HEIGHT,
  DOCUMENT_NODE_WIDTH,
  fileNodeDefaults,
  GROUP_FRAME_HEIGHT,
  GROUP_FRAME_WIDTH,
  GROUP_PADDING_PX,
  groupEnclosure,
  groupNodeDefaults,
  IMAGE_NODE_HEIGHT,
  IMAGE_NODE_WIDTH,
  imageNodeDefaults,
  LINK_NODE_HEIGHT,
  linkNodeDefaults,
  resolveSpawnPoint,
  textNodeDefaults,
} from './node-factories.js'

describe('node factories', () => {
  it('textNodeDefaults centers a NEW_NODE_WIDTH/HEIGHT box on the given point, rounding to integers', () => {
    const node = textNodeDefaults('id-1', { x: 100.4, y: 50.6 }, 'hello')
    expect(node).toMatchObject({ id: 'id-1', type: 'text', text: 'hello' })
    expect(Number.isInteger(node.x)).toBe(true)
    expect(Number.isInteger(node.y)).toBe(true)
  })

  it('linkNodeDefaults uses the shorter LINK_NODE_HEIGHT default (60)', () => {
    const node = linkNodeDefaults('id-2', { x: 0, y: 0 }, 'https://example.com')
    expect(LINK_NODE_HEIGHT).toBe(60)
    expect(node).toMatchObject({ type: 'link', url: 'https://example.com', height: 60 })
  })

  it('fileNodeDefaults uses the shorter LINK_NODE_HEIGHT default (60)', () => {
    const node = fileNodeDefaults('id-3', { x: 0, y: 0 }, 'notes.canvas')
    expect(node).toMatchObject({ type: 'file', file: 'notes.canvas', height: 60 })
  })

  it('imageNodeDefaults uses the 240x180 default', () => {
    expect(IMAGE_NODE_WIDTH).toBe(240)
    expect(IMAGE_NODE_HEIGHT).toBe(180)
    const node = imageNodeDefaults('id-4', { x: 0, y: 0 }, 'photo.png')
    expect(node).toMatchObject({ type: 'file', file: 'photo.png', width: 240, height: 180 })
  })

  it('groupNodeDefaults uses the 320x200 default', () => {
    expect(GROUP_FRAME_WIDTH).toBe(320)
    expect(GROUP_FRAME_HEIGHT).toBe(200)
    const node = groupNodeDefaults('id-5', { x: 0, y: 0 })
    expect(node).toMatchObject({ type: 'group', width: 320, height: 200 })
  })

  it('every factory centers its box: point sits at (x + width/2, y + height/2)', () => {
    const point = { x: 400, y: 300 }
    const node = imageNodeDefaults('id-6', point, 'photo.png')
    expect(node.x + node.width / 2).toBe(point.x)
    expect(node.y + node.height / 2).toBe(point.y)
  })
})

describe('resolveSpawnPoint', () => {
  const size = { width: 100, height: 50 }

  it('returns the anchor verbatim when given, ignoring findFreeSpot entirely', () => {
    const anchor = { x: 42, y: 42 }
    const occupied = [{ x: 42, y: 42, width: 500, height: 500 }] // would collide if findFreeSpot ran
    expect(resolveSpawnPoint(anchor, { x: 0, y: 0 }, size, occupied)).toEqual(anchor)
  })

  it('falls back to findFreeSpot(preferred, size, occupied) when no anchor is given', () => {
    const preferred = { x: 0, y: 0 }
    expect(resolveSpawnPoint(undefined, preferred, size, [])).toEqual(preferred)
  })

  it('cascades away from an occupied preferred spot when no anchor is given', () => {
    const preferred = { x: 0, y: 0 }
    const occupied = [{ x: -50, y: -25, width: 100, height: 50 }]
    const spot = resolveSpawnPoint(undefined, preferred, size, occupied)
    expect(spot).not.toEqual(preferred)
  })
})

describe('groupEnclosure', () => {
  it('frames the union of member boxes, grown by GROUP_PADDING_PX on every side', () => {
    expect(GROUP_PADDING_PX).toBe(24)
    const members = [
      { x: 0, y: 0, width: 100, height: 50 },
      { x: 200, y: 100, width: 40, height: 40 },
    ]
    // union: x in [0, 240], y in [0, 140] -> padded by 24 on every side.
    expect(groupEnclosure(members)).toEqual({ x: -24, y: -24, width: 288, height: 188 })
  })

  it('returns undefined for an empty member list (no-op signal)', () => {
    expect(groupEnclosure([])).toBeUndefined()
  })

  it('every side clearance to the nearest member equals GROUP_PADDING_PX exactly', () => {
    const members = [{ x: 10, y: 10, width: 30, height: 20 }]
    const frame = groupEnclosure(members)
    expect(frame).toEqual({
      x: 10 - GROUP_PADDING_PX,
      y: 10 - GROUP_PADDING_PX,
      width: 30 + GROUP_PADDING_PX * 2,
      height: 20 + GROUP_PADDING_PX * 2,
    })
  })
})

describe('fileNodeDefaults sizing', () => {
  // Verified in the running app: at the reference-card height the padded
  // content box is 44px, not one markdown block fits, and the referenced
  // body renders as nothing at all. Every test passed while the feature was
  // invisible at the size the app actually creates — which is why the
  // geometry is pinned here rather than left to the constants.
  it('gives a markdown reference room for prose', () => {
    const node = fileNodeDefaults('n1', { x: 0, y: 0 }, 'notes', 'markdown')
    expect(node.width).toBe(DOCUMENT_NODE_WIDTH)
    expect(node.height).toBe(DOCUMENT_NODE_HEIGHT)
    // The floor that matters is the padded content box, not the box: this
    // is what `fitBodyInNode` measures blocks against.
    expect(node.height - 2 * SPATIAL_THEME_GEOMETRY.paddingPx).toBeGreaterThan(120)
  })

  it('keeps the one-line card for a spatial reference and for an unknown kind', () => {
    for (const kind of ['spatial', undefined] as const) {
      const node = fileNodeDefaults('n1', { x: 0, y: 0 }, 'diagram', kind)
      expect(node.height).toBe(LINK_NODE_HEIGHT)
      expect(node.width).toBe(NEW_NODE_WIDTH)
    }
  })
})
