import { canvasIdSchema } from '@kamiazya/whiteboard-canvas-model'
import { describe, expect, it } from 'vitest'
import { generateCanvasId } from './generate-canvas-id.js'

describe('generateCanvasId', () => {
  it('produces a 26-character string matching canvasIdSchema', () => {
    const id = generateCanvasId()
    expect(id).toHaveLength(26)
    expect(() => canvasIdSchema.parse(id)).not.toThrow()
  })

  it('produces different ids on consecutive calls', () => {
    const first = generateCanvasId()
    const second = generateCanvasId()
    expect(first).not.toBe(second)
  })
})
