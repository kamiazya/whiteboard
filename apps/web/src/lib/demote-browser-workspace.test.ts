/**
 * The demote's registry and tombstone half over fake-indexeddb. The flows
 * that need real IndexedDB — trash bytes, saved versions, the open-tab lock —
 * are demote-browser-workspace.browser.test.tsx; this file holds what a
 * removal leaves in the registry and the meta store.
 */

// jsdom + fake-indexeddb: this is IndexedDB persistence logic, not browser layout.
import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { clearWhiteboardDb } from '../test-utils/browser-document.js'
import { claimIsolatedWhiteboardDb } from '../test-utils/isolated-whiteboard-db.js'
import { openWhiteboardDb, WORKSPACES_STORE } from './browser-idb.js'
import { BrowserWorkspaceDocs } from './browser-workspace-docs.js'
import {
  getBrowserWorkspaceId,
  resetBrowserWorkspaceIdForTests,
  resolveBrowserWorkspaceId,
} from './browser-workspace-id.js'
import { demoteBrowserWorkspace } from './demote-browser-workspace.js'
import { request } from './idb-tx.js'
import { isWorkspaceRemovedError, refuseIfRemoved } from './workspace-tombstone.js'

claimIsolatedWhiteboardDb('demotebrowserworkspacejsdom')

async function registryRows(): Promise<string[]> {
  const db = await openWhiteboardDb()
  try {
    const keys = await request(
      db.transaction([WORKSPACES_STORE]).objectStore(WORKSPACES_STORE).getAllKeys(),
    )
    return keys.map(String)
  } finally {
    db.close()
  }
}

async function seedWorkspace(workspaceId: string): Promise<void> {
  const db = await openWhiteboardDb()
  try {
    const tx = db.transaction([WORKSPACES_STORE], 'readwrite')
    tx.objectStore(WORKSPACES_STORE).put({ workspaceId, segment: 'other' }, workspaceId)
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
  } finally {
    db.close()
  }
}

describe('demoteBrowserWorkspace over the registry', () => {
  beforeEach(async () => {
    await clearWhiteboardDb()
    resetBrowserWorkspaceIdForTests()
  })

  it('tombstones the removed id, so neither minting writer brings it back', async () => {
    const sourceId = await resolveBrowserWorkspaceId()
    const docs = new BrowserWorkspaceDocs()
    await docs.create(sourceId)

    await demoteBrowserWorkspace(sourceId)

    expect(await docs.open(sourceId)).toBeNull()
    const refused = await refuseIfRemoved(sourceId).catch((err: unknown) => err)
    expect(isWorkspaceRemovedError(refused)).toBe(true)
    await expect(docs.create(sourceId)).rejects.toSatisfy(isWorkspaceRemovedError)
    expect(await registryRows()).not.toContain(sourceId)
  })

  it('re-points at a remaining workspace rather than minting one', async () => {
    const sourceId = await resolveBrowserWorkspaceId()
    await new BrowserWorkspaceDocs().create(sourceId)
    await seedWorkspace('01ARZ3NDEKTSV4RRFFQ69G5FAZ')

    await demoteBrowserWorkspace(sourceId)

    expect(await registryRows()).toEqual(['01ARZ3NDEKTSV4RRFFQ69G5FAZ'])
    expect(getBrowserWorkspaceId()).toBe('01ARZ3NDEKTSV4RRFFQ69G5FAZ')
  })

  it('mints a fresh workspace when the removed one was the last', async () => {
    const sourceId = await resolveBrowserWorkspaceId()
    await new BrowserWorkspaceDocs().create(sourceId)

    await demoteBrowserWorkspace(sourceId)

    const rows = await registryRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]).not.toBe(sourceId)
    expect(getBrowserWorkspaceId()).toBe(rows[0])
    await expect(refuseIfRemoved(rows[0] ?? '')).resolves.toBeUndefined()
  })
})
