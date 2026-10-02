import { WorkspaceNotFoundError } from '@kamiazya/whiteboard-ports'
import { describe, expect, it } from 'vitest'
import {
  WorkspaceDocumentNotFoundError,
  WorkspaceNotFoundForCallerError,
} from './document-crud.errors.js'

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

describe('WorkspaceNotFoundForCallerError', () => {
  it('is its own class, apart from the port error of the same condition', () => {
    const tool = new WorkspaceNotFoundForCallerError('ws-1')
    expect(tool).toBeInstanceOf(Error)
    expect(tool).not.toBeInstanceOf(WorkspaceNotFoundError)
    expect(new WorkspaceNotFoundError('ws-1')).not.toBeInstanceOf(WorkspaceNotFoundForCallerError)
    expect(tool.name).toBe('WorkspaceNotFoundForCallerError')
    expect(tool.workspaceId).toBe('ws-1')
  })

  it('advises createWorkspace on the call that can carry it, and not on a read', () => {
    expect(new WorkspaceNotFoundForCallerError('ws-1', 'create').message).toContain(
      'Pass createWorkspace: true on this wb_workspace_edit call',
    )
    const read = new WorkspaceNotFoundForCallerError('ws-1', 'read').message
    expect(read).toContain('Workspace not found: "ws-1"')
    expect(read).not.toContain('Pass createWorkspace')
  })
})
