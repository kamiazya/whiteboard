import { describe, expect, test } from 'vitest'
import {
  CanvasDocNotFoundError,
  EdgeNotFoundError,
  NodeNotFoundError,
  NotATextNodeError,
  PatchValidationError,
} from './errors.js'

describe('server-core tool errors', () => {
  test('CanvasDocNotFoundError carries the canvasId and a descriptive message', () => {
    const err = new CanvasDocNotFoundError('canvas-1')
    expect(err).toBeInstanceOf(Error)
    expect(err.name).toBe('CanvasDocNotFoundError')
    expect(err.canvasId).toBe('canvas-1')
    expect(err.message).toContain('canvas-1')
  })

  test('NodeNotFoundError carries canvasId and nodeId', () => {
    const err = new NodeNotFoundError('canvas-1', 'node-1')
    expect(err).toBeInstanceOf(Error)
    expect(err.name).toBe('NodeNotFoundError')
    expect(err.canvasId).toBe('canvas-1')
    expect(err.nodeId).toBe('node-1')
    expect(err.message).toContain('node-1')
    expect(err.message).toContain('canvas-1')
  })

  test('EdgeNotFoundError carries canvasId and edgeId', () => {
    const err = new EdgeNotFoundError('canvas-1', 'edge-1')
    expect(err).toBeInstanceOf(Error)
    expect(err.name).toBe('EdgeNotFoundError')
    expect(err.canvasId).toBe('canvas-1')
    expect(err.edgeId).toBe('edge-1')
    expect(err.message).toContain('edge-1')
    expect(err.message).toContain('canvas-1')
  })

  test('PatchValidationError carries the issues and joins their messages', () => {
    const issues = [
      { code: 'custom', message: 'bad thing', path: ['edges', 0, 'fromNode'] },
    ] as unknown as import('zod').ZodIssue[]
    const err = new PatchValidationError(issues)
    expect(err).toBeInstanceOf(Error)
    expect(err.name).toBe('PatchValidationError')
    expect(err.issues).toBe(issues)
    expect(err.message).toContain('bad thing')
  })

  test('NotATextNodeError carries canvasId, nodeId, and actualType', () => {
    const err = new NotATextNodeError('canvas-1', 'node-1', 'file')
    expect(err).toBeInstanceOf(Error)
    expect(err.name).toBe('NotATextNodeError')
    expect(err.canvasId).toBe('canvas-1')
    expect(err.nodeId).toBe('node-1')
    expect(err.actualType).toBe('file')
    expect(err.message).toContain('file')
  })
})
