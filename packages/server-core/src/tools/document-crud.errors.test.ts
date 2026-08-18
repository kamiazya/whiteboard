import { describe, expect, it } from 'vitest'
import { WorkspaceDocumentNotFoundError } from './document-crud.errors.js'

describe('WorkspaceDocumentNotFoundError', () => {
  it('carries workspaceId and documentId', () => {
    const err = new WorkspaceDocumentNotFoundError('ws-1', 'canvas-abc')
    expect(err).toBeInstanceOf(Error)
    expect(err.name).toBe('WorkspaceDocumentNotFoundError')
    expect(err.workspaceId).toBe('ws-1')
    expect(err.documentId).toBe('canvas-abc')
    expect(err.message).toContain('canvas-abc')
    expect(err.message).toContain('ws-1')
  })
})
