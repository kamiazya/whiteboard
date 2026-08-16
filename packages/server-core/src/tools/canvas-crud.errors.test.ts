import { describe, expect, it } from 'vitest'
import { CanvasNotFoundError } from './canvas-crud.errors.js'

describe('CanvasNotFoundError', () => {
  it('carries workspaceId and documentId', () => {
    const err = new CanvasNotFoundError('ws-1', 'canvas-abc')
    expect(err).toBeInstanceOf(Error)
    expect(err.name).toBe('CanvasNotFoundError')
    expect(err.workspaceId).toBe('ws-1')
    expect(err.documentId).toBe('canvas-abc')
    expect(err.message).toContain('canvas-abc')
    expect(err.message).toContain('ws-1')
  })
})
