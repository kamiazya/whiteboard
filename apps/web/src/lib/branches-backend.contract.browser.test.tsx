/**
 * The branches contract against the BROWSER keeper, over a real IndexedDB
 * workspace record.
 *
 * The daemon half of this suite runs in `branches-backend.contract.test.ts`,
 * against a stand-in for its routes — a client test that needs no browser.
 * This half needs one: the browser keeper IS its storage, so a stand-in here
 * would only assert that this file's stand-in does what this file's stand-in
 * does. The record, the write queue and the plane are the subject.
 *
 * Same contract, both keepers, which is the point of `branchesBackendContract`
 * existing at all — a behaviour one keeper gets wrong is otherwise caught only
 * if somebody thought to write that case in that keeper's own file.
 */
import { describe, expect, vi } from 'vitest'
import { clearWhiteboardDb } from '../test-utils/browser-document.js'
import { claimIsolatedWhiteboardDb } from '../test-utils/isolated-whiteboard-db.js'
import {
  type BranchesBackendHarness,
  branchesBackendContract,
} from './branches-backend.contract.js'
import { BrowserBackend } from './browser-backend.js'
import { createBrowserBranchesBackend } from './browser-branches-backend.js'
import { BrowserWorkspaceDocs } from './browser-workspace-docs.js'
import { getBrowserWorkspaceId } from './browser-workspace-id.js'
import { FoldingBrowserIndex } from './folding-browser-index.js'

claimIsolatedWhiteboardDb('branchesbackendcontract')

async function browserHarness(): Promise<BranchesBackendHarness> {
  await clearWhiteboardDb()
  const workspaceId = getBrowserWorkspaceId()
  const index = new FoldingBrowserIndex()
  await index.createWorkspace({ workspaceId })
  const { documentId } = await index.createDocument({
    workspaceId,
    path: 'canvas-a',
    kind: 'spatial',
  })

  const docs = new BrowserWorkspaceDocs()
  const backend = new BrowserBackend({ documentId, path: 'canvas-a', kind: 'spatial' }, docs)
  // A branch write lands on the record the BACKEND holds, so it has to be
  // connected for one to have anywhere to go — the same reason the versions
  // contract's browser harness connects before a restore.
  backend.connect({
    onSnapshot: () => {},
    onRemoteUpdate: () => {},
    onConnected: () => {},
    onDisconnected: () => {},
    onRestoreStarted: () => {},
    onRestoreComplete: () => {},
    onVersionCreated: () => {},
    onHeadChanged: () => {},
    onViewportRequest: () => {},
    onExportRequest: () => {},
  })
  // Wait for the CONDITION the harness actually needs — the record delivered
  // — rather than for a duration. `readRecord` answers null until then, so
  // this is the same question the backend asks itself.
  await vi.waitFor(() => expect(backend.readRecord(() => true)).toBe(true))

  return {
    backend: createBrowserBranchesBackend({ backend }),
    workspaceId,
    path: 'canvas-a',
    async cleanup() {
      backend.disconnect()
      await clearWhiteboardDb()
    },
  }
}

describe('BranchesBackend contract — browser keeper (real IndexedDB record)', () => {
  branchesBackendContract(browserHarness)
})
