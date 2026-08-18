import { describe, expect, test } from 'vitest'
import { SnapshotNotFoundError } from './document-io.js'
import {
  EdgeNotFoundError,
  NodeNotFoundError,
  NotATextNodeError,
  PatchValidationError,
} from './errors.js'

describe('server-core tool errors', () => {
  test('SnapshotNotFoundError carries the documentId and a descriptive message', () => {
    const err = new SnapshotNotFoundError('canvas-1')
    expect(err).toBeInstanceOf(Error)
    expect(err.name).toBe('SnapshotNotFoundError')
    expect(err.documentId).toBe('canvas-1')
    expect(err.message).toContain('canvas-1')
  })

  test('NodeNotFoundError carries documentId and nodeId', () => {
    const err = new NodeNotFoundError('canvas-1', 'node-1')
    expect(err).toBeInstanceOf(Error)
    expect(err.name).toBe('NodeNotFoundError')
    expect(err.documentId).toBe('canvas-1')
    expect(err.nodeId).toBe('node-1')
    expect(err.message).toContain('node-1')
    expect(err.message).toContain('canvas-1')
  })

  test('EdgeNotFoundError carries documentId and edgeId', () => {
    const err = new EdgeNotFoundError('canvas-1', 'edge-1')
    expect(err).toBeInstanceOf(Error)
    expect(err.name).toBe('EdgeNotFoundError')
    expect(err.documentId).toBe('canvas-1')
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

  test('NotATextNodeError carries documentId, nodeId, and actualType', () => {
    const err = new NotATextNodeError('canvas-1', 'node-1', 'file')
    expect(err).toBeInstanceOf(Error)
    expect(err.name).toBe('NotATextNodeError')
    expect(err.documentId).toBe('canvas-1')
    expect(err.nodeId).toBe('node-1')
    expect(err.actualType).toBe('file')
    expect(err.message).toContain('file')
  })
})
