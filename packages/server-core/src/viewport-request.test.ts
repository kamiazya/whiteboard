import { MAX_VIEWPORT_ZOOM, MIN_VIEWPORT_ZOOM } from '@kamiazya/whiteboard-model'
import { describe, expect, test } from 'vitest'
import { viewportRequestParamsSchema } from './viewport-request.js'

describe('viewportRequestParamsSchema zoom', () => {
  test.each([
    0,
    -3,
    1e9,
    100,
    MIN_VIEWPORT_ZOOM / 2,
    MAX_VIEWPORT_ZOOM * 2,
  ])('refuses %s, which the editor cannot show', (zoom) => {
    expect(viewportRequestParamsSchema.safeParse({ mode: 'move', zoom }).success).toBe(false)
  })

  test.each([
    MIN_VIEWPORT_ZOOM,
    1,
    MAX_VIEWPORT_ZOOM,
  ])('accepts %s, inside the editor range', (zoom) => {
    expect(viewportRequestParamsSchema.safeParse({ mode: 'move', zoom }).success).toBe(true)
  })

  test('names the range in the refusal so a percentage zoom is recognisable as one', () => {
    const result = viewportRequestParamsSchema.safeParse({ zoom: 100 })
    expect(result.success).toBe(false)
    expect(JSON.stringify(result.error?.issues)).toContain(String(MAX_VIEWPORT_ZOOM))
  })
})
