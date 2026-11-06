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
    const err = new WorkspaceDocumentNotFoundError('01ZVM89A4A1V9FS03Z9J64KEK1', 'canvas-abc')
    expect(err).toBeInstanceOf(Error)
    expect(err.name).toBe('WorkspaceDocumentNotFoundError')
    expect(err.workspaceId).toBe('01ZVM89A4A1V9FS03Z9J64KEK1')
    expect(err.documentId).toBe('canvas-abc')
    expect(err.message).toContain('canvas-abc')
    expect(err.message).toContain('01ZVM89A4A1V9FS03Z9J64KEK1')
  })

  // The error is thrown for either kind of document, so its wording cannot
  // name one: a missing markdown note read "Canvas not found" through MCP.
  it('refuses a missing markdown document as a document, not as a canvas', async () => {
    const deps = makeTestDeps()
    await deps.documentIndex.createWorkspace({ workspaceId: '01ZVM89A4A1V9FS03Z9J64KEK1' })
    await wbDocumentCreate(deps, {
      workspaceId: '01ZVM89A4A1V9FS03Z9J64KEK1',
      path: 'note',
      kind: 'markdown',
    })
    await expect(
      wbDocumentResolve(deps, {
        workspaceId: '01ZVM89A4A1V9FS03Z9J64KEK1',
        documentId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
      }),
    ).rejects.toThrow(
      'Document not found: 01ARZ3NDEKTSV4RRFFQ69G5FAV in workspace 01ZVM89A4A1V9FS03Z9J64KEK1',
    )
  })
})

describe('WorkspaceNotFoundForCallerError', () => {
  it('is its own class, apart from the port error of the same condition', () => {
    const tool = new WorkspaceNotFoundForCallerError('01ZVM89A4A1V9FS03Z9J64KEK1')
    expect(tool).toBeInstanceOf(Error)
    expect(tool).not.toBeInstanceOf(WorkspaceNotFoundError)
    expect(new WorkspaceNotFoundError('01ZVM89A4A1V9FS03Z9J64KEK1')).not.toBeInstanceOf(
      WorkspaceNotFoundForCallerError,
    )
    expect(tool.name).toBe('WorkspaceNotFoundForCallerError')
    expect(tool.workspaceId).toBe('01ZVM89A4A1V9FS03Z9J64KEK1')
  })

  it('advises createWorkspace on the call that can carry it, and not on a read', () => {
    expect(
      new WorkspaceNotFoundForCallerError('01ZVM89A4A1V9FS03Z9J64KEK1', 'create').message,
    ).toContain('Pass createWorkspace: true on this wb_workspace_edit call')
    const read = new WorkspaceNotFoundForCallerError('01ZVM89A4A1V9FS03Z9J64KEK1', 'read').message
    expect(read).toContain('Workspace not found: "01ZVM89A4A1V9FS03Z9J64KEK1"')
    expect(read).not.toContain('Pass createWorkspace')
  })
})
