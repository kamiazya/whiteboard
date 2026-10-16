// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  documentSnapshotUrl,
  documentSyncKey,
  documentUpdateUrl,
  workspaceDocKey,
  workspaceHandleOfSyncKey,
  workspaceIdOfSyncKey,
} from './sync-key.js'

describe('doc-key URL mapping', () => {
  it('maps a workspace-scope key to the workspace-document routes', () => {
    expect(documentUpdateUrl('http://d', 'workspace:ws-1')).toBe(
      'http://d/api/w/ws-1/workspace-document/update',
    )
    expect(documentSnapshotUrl('http://d', 'workspace:ws-1')).toBe(
      'http://d/api/w/ws-1/workspace-document/snapshot',
    )
  })

  it('still maps a per-document key to the per-document routes', () => {
    expect(documentUpdateUrl('http://d', 'ws-1/nested/path')).toBe(
      'http://d/api/w/ws-1/document/nested/path/update',
    )
  })
})

describe('documentSyncKey', () => {
  it('joins the handle and the path on one slash, keeping the path whole', () => {
    expect(documentSyncKey('ws-1', 'nested/path')).toBe('ws-1/nested/path')
  })

  it('is read back by the two parsers as a per-document key', () => {
    const key = documentSyncKey('ws-1', 'a')
    expect(workspaceHandleOfSyncKey(key)).toBe('ws-1')
    expect(workspaceIdOfSyncKey(key)).toBeNull()
  })
})

describe('workspaceHandleOfSyncKey', () => {
  it('reads the handle straight off a workspace-scope key', () => {
    expect(workspaceHandleOfSyncKey('workspace:ws-1')).toBe('ws-1')
  })

  it('reads the handle off the first slash of a per-document key', () => {
    expect(workspaceHandleOfSyncKey('ws-1/nested/path')).toBe('ws-1')
  })

  it('refuses a malformed key', () => {
    expect(workspaceHandleOfSyncKey('workspace:')).toBeNull()
    expect(workspaceHandleOfSyncKey('no-slash-here')).toBeNull()
    expect(workspaceHandleOfSyncKey('/leading-slash')).toBeNull()
  })

  it('refuses a handle with no path behind it, and builds no snapshot URL for it', () => {
    expect(workspaceHandleOfSyncKey('ws-1/')).toBeNull()
    expect(documentSnapshotUrl('http://d', 'ws-1/')).toBeNull()
  })
})

describe('workspaceIdOfSyncKey', () => {
  it('reads the id off a workspace-scope key', () => {
    expect(workspaceIdOfSyncKey('workspace:ws-1')).toBe('ws-1')
  })

  it('answers null for a per-document key, which names a handle and a path rather than a workspace-scope subscription', () => {
    expect(workspaceIdOfSyncKey('ws-1/nested/path')).toBeNull()
  })

  it('answers null for the bare prefix and for the stored key shape', () => {
    expect(workspaceIdOfSyncKey('workspace:')).toBeNull()
    expect(workspaceIdOfSyncKey('workspace-tree:ws-1')).toBeNull()
  })

  it('is the inverse of workspaceDocKey', () => {
    expect(workspaceIdOfSyncKey(workspaceDocKey('ws-1'))).toBe('ws-1')
  })
})
