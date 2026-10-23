import { createFakeMeasure } from '@kamiazya/whiteboard-canvas-render/test-utils'
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { describe, expect, it } from 'vitest'
import { buildSpatialScene } from './headless-renderer.js'

const NOTE = textNode({ id: 'n1', x: 0, y: 0, width: 200, height: 50, text: 'hi' })

describe('the daemon export picture', () => {
  it('leaves a canvas comment out, so the saved board is the board', () => {
    const bare: SpatialCanvas = { nodes: [NOTE], edges: [] }
    const commented: SpatialCanvas = {
      ...bare,
      comments: [{ id: 'c1', x: 250, y: 20, text: 'check this' }],
    }
    const measure = createFakeMeasure(0.6)
    expect(JSON.stringify(buildSpatialScene(commented, measure))).toBe(
      JSON.stringify(buildSpatialScene(bare, measure)),
    )
  })
})
