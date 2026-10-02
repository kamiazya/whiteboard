import { describe, expect, test } from 'vitest'
import { SnapshotNotFoundError } from './document-io.js'
import { NodeNotFoundError } from './errors.js'

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
})
