import { describe, expect, test } from 'vitest'
import { SnapshotNotFoundError } from '../document-io.js'
import { DocumentSerializeError, EdgeNotFoundError, NodeNotFoundError } from './errors.js'

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

  // `canvas` is the surface; the thing that holds the node is a document.
  test('a missing node or edge is said to be missing from a document, not a canvas', () => {
    expect(new NodeNotFoundError('doc-1', 'n').message).toBe('node not found: n in document doc-1')
    expect(new EdgeNotFoundError('doc-1', 'e').message).toBe('edge not found: e in document doc-1')
  })

  // A model reads this message, and serializers do throw plain `{ code }`
  // objects, whose `String()` is `[object Object]`.
  test('a serialize failure caused by a plain object says what the object carried', () => {
    const err = new DocumentSerializeError('doc-1', 'okf', { code: 'X' })
    expect(err.message).toContain('"code"')
    expect(err.message).not.toContain('[object Object]')
  })
})
