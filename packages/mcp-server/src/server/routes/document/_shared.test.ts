import {
  DocumentNotFoundError,
  isDocumentNotFoundError,
  WorkspaceNotFoundError,
} from '@kamiazya/whiteboard-ports'
import { WorkspaceNotFoundForCallerError } from '@kamiazya/whiteboard-server-core'
import { describe, expect, it } from 'vitest'
import { firstOwned, notFoundAs, STORED_DOCUMENT_ANSWERS, workspaceNotFound } from './_shared.js'

describe('the not-found translations over the port error', () => {
  const absent = new DocumentNotFoundError('ws', 'notes/a')

  it('answers a metadata writer absence as 404 with the error message', () => {
    expect(firstOwned(absent, STORED_DOCUMENT_ANSWERS)).toEqual({
      status: 404,
      body: { error: 'not_found', message: absent.message },
    })
  })

  it('answers the caller-supplied title for an absent document', () => {
    expect(notFoundAs('Document "notes/a" not found')(absent)).toEqual({
      status: 404,
      body: { title: 'Document "notes/a" not found' },
    })
  })

  it('answers an absent workspace in the shared workspace voice, not the document title', () => {
    expect(notFoundAs('gone')(new WorkspaceNotFoundError('ws'))).toEqual({
      status: 404,
      body: { error: 'workspace_not_found', message: 'Workspace "ws" not found' },
    })
  })

  it("answers the tool layer's own absent-workspace error the same way", () => {
    const toolError = new WorkspaceNotFoundForCallerError('ws')
    const workspaceVoice = {
      status: 404,
      body: { error: 'workspace_not_found', message: 'Workspace "ws" not found' },
    }
    expect(notFoundAs('gone')(toolError)).toEqual(workspaceVoice)
    expect(workspaceNotFound(toolError)).toEqual(workspaceVoice)
  })

  it('leaves an unrelated error to the caller', () => {
    expect(firstOwned(new Error('boom'), STORED_DOCUMENT_ANSWERS)).toBeNull()
    expect(notFoundAs('gone')(new Error('boom'))).toBeNull()
    expect(workspaceNotFound(new Error('boom'))).toBeNull()
  })
})

describe('isDocumentNotFoundError', () => {
  it('recognises an error from another load of the same class by its name', () => {
    const otherRealm = new Error('No document')
    otherRealm.name = 'DocumentNotFoundError'
    expect(isDocumentNotFoundError(otherRealm)).toBe(true)
  })

  it('refuses a non-error carrying the name', () => {
    expect(isDocumentNotFoundError({ name: 'DocumentNotFoundError' })).toBe(false)
  })
})
