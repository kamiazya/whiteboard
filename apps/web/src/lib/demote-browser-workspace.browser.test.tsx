/**
 * The demote deletion's own contract, at the function level — the section's
 * flow tests share one IndexedDB across a whole file, so the registry there
 * is never empty and the last-workspace mint could rot unobserved (measured:
 * dropping the mint survived the flow suite).
 */
import { readWorkspaceDocuments, writeDocumentKind } from '@kamiazya/whiteboard-loro-adapter'
import { beforeEach, describe, expect, it } from 'vitest'
import { claimIsolatedWhiteboardDb } from '../test-utils/isolated-whiteboard-db.js'
import { BROWSER_DEFAULT_SEGMENT, openWhiteboardDb, WORKSPACES_STORE } from './browser-idb.js'
import { BrowserWorkspaceDocs } from './browser-workspace-docs.js'
import {
  getBrowserWorkspaceId,
  resetBrowserWorkspaceIdForTests,
  resolveBrowserWorkspaceId,
} from './browser-workspace-id.js'
import { demoteBrowserWorkspace, replicaCarriesAll } from './demote-browser-workspace.js'

claimIsolatedWhiteboardDb('demote-browser-workspace')

async function registryRows(): Promise<string[]> {
  const db = await openWhiteboardDb()
  try {
    return await new Promise<string[]>((resolve, reject) => {
      const req = db.transaction([WORKSPACES_STORE]).objectStore(WORKSPACES_STORE).getAllKeys()
      req.onsuccess = () => resolve(req.result.map(String))
      req.onerror = () => reject(req.error)
    })
  } finally {
    db.close()
  }
}

describe('demoteBrowserWorkspace', () => {
  beforeEach(() => {
    // The shared setup may have resolved the identity against another
    // database; this file's claims are about ITS isolated one.
    resetBrowserWorkspaceIdForTests()
  })

  it('deleting the last workspace mints a fresh empty one and re-points the identity', async () => {
    const sourceId = await resolveBrowserWorkspaceId()
    const docs = new BrowserWorkspaceDocs()
    await docs.create(sourceId)
    expect(await registryRows()).toEqual([sourceId])

    await demoteBrowserWorkspace(sourceId)

    expect(await docs.open(sourceId)).toBeNull()
    const rows = await registryRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]).not.toBe(sourceId)
    // The in-memory identity followed, so a racing write cannot resurrect
    // the deleted record under its old id.
    expect(getBrowserWorkspaceId()).toBe(rows[0])
    // The fresh row carries the default segment, so addresses keep a name.
    const db = await openWhiteboardDb()
    try {
      const row = await new Promise<{ segment?: string }>((resolve, reject) => {
        const req = db
          .transaction([WORKSPACES_STORE])
          .objectStore(WORKSPACES_STORE)
          .get(rows[0] as string)
        req.onsuccess = () => resolve(req.result as { segment?: string })
        req.onerror = () => reject(req.error)
      })
      expect(row.segment).toBe(BROWSER_DEFAULT_SEGMENT)
    } finally {
      db.close()
    }
  })
})

describe('replicaCarriesAll', () => {
  it('a missing replica record carries nothing', async () => {
    expect(
      await replicaCarriesAll(new BrowserWorkspaceDocs(), 'ws-absent', [
        '01ARZ3NDEKTSV4RRFFQ69G5FAV',
      ]),
    ).toBe(false)
  })

  it('answers by membership of every promoted id', async () => {
    const docs = new BrowserWorkspaceDocs()
    const record = await docs.create('ws-replica')
    // A record with no documents: ids are absent, so nothing is carried.
    writeDocumentKind(record, 'markdown')
    await docs.save('ws-replica', record)
    expect(readWorkspaceDocuments(record)).toEqual([])
    expect(await replicaCarriesAll(docs, 'ws-replica', ['01ARZ3NDEKTSV4RRFFQ69G5FAV'])).toBe(false)
    expect(await replicaCarriesAll(docs, 'ws-replica', [])).toBe(true)
  })
})
