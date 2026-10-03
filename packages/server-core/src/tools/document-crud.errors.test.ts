import { WorkspaceNotFoundError } from '@kamiazya/whiteboard-ports'
import { describe, expect, it } from 'vitest'
import { makeTestDeps } from '../test-utils/make-test-deps.js'
import {
  WorkspaceDocumentNotFoundError,
  WorkspaceNotFoundForCallerError,
} from './document-crud.errors.js'
import { wbDocumentCreate, wbDocumentResolve } from './document-crud.js'

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

  // The error is thrown for either kind of document, so its wording cannot
  // name one: a missing markdown note read "Canvas not found" through MCP.
  it('refuses a missing markdown document as a document, not as a canvas', async () => {
    const deps = makeTestDeps()
    await deps.documentIndex.createWorkspace({ workspaceId: 'ws-1' })
    await wbDocumentCreate(deps, { workspaceId: 'ws-1', path: 'note', kind: 'markdown' })
    await expect(
      wbDocumentResolve(deps, { workspaceId: 'ws-1', documentId: '01ARZ3NDEKTSV4RRFFQ69G5FAV' }),
    ).rejects.toThrow('Document not found: 01ARZ3NDEKTSV4RRFFQ69G5FAV in workspace ws-1')
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
