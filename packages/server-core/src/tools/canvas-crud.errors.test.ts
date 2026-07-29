import { describe, expect, it } from 'vitest'
import {
  CanvasNotFoundError,
  CanvasParentNotFoundError,
  CanvasSegmentConflictError,
} from './canvas-crud.errors.js'

describe('CanvasNotFoundError', () => {
  it('carries workspaceId and canvasId', () => {
    const err = new CanvasNotFoundError('ws-1', 'canvas-abc')
    expect(err).toBeInstanceOf(Error)
    expect(err.name).toBe('CanvasNotFoundError')
    expect(err.workspaceId).toBe('ws-1')
    expect(err.canvasId).toBe('canvas-abc')
    expect(err.message).toContain('canvas-abc')
    expect(err.message).toContain('ws-1')
  })
})

describe('CanvasSegmentConflictError', () => {
  it('carries the conflicting segment', () => {
    const err = new CanvasSegmentConflictError('my-doc')
    expect(err).toBeInstanceOf(Error)
    expect(err.name).toBe('CanvasSegmentConflictError')
    expect(err.segment).toBe('my-doc')
    expect(err.message).toContain('my-doc')
  })
})

describe('CanvasParentNotFoundError', () => {
  it('carries the parentId', () => {
    const err = new CanvasParentNotFoundError('parent-xyz')
    expect(err).toBeInstanceOf(Error)
    expect(err.name).toBe('CanvasParentNotFoundError')
    expect(err.parentId).toBe('parent-xyz')
    expect(err.message).toContain('parent-xyz')
  })
})
