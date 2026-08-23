/**
 * Real-IndexedDB browser test: seeds the actual IdbDocumentIndex + LoroStore
 * with two documents (one with deltas), imports both, and asserts copy-first
 * — after import the source store's contents are byte-identical.
 */

// jsdom + fake-indexeddb: this file exercises the copy-first import flow over
// IndexedDB persistence, not browser layout or input fidelity — the real-IDB
// contract stays pinned by idb-document-index/loro-store/browser-backend/
// browser-idb-migration in the browser project. (ImportFromBrowserPanel.test.tsx
// is the store-double suite; this one drives the real stores.)
import 'fake-indexeddb/auto'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { Loro } from 'loro-crdt'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IdbDocumentIndex } from '../../lib/idb-document-index.js'
import { listLocalDocuments } from '../../lib/local-document-summary.js'
import { LoroStore } from '../../lib/loro-store.js'
import { createUserSettingsStore } from '../../lib/user-settings-store.js'
import { claimIsolatedWhiteboardDb } from '../../test-utils/isolated-whiteboard-db.js'
import { ImportFromBrowserPanel } from './ImportFromBrowserPanel.js'

const ISOLATED_DB = claimIsolatedWhiteboardDb('importfrombrowserpanel')

async function clearDb(): Promise<void> {
  return new Promise((resolve) => {
    const req = indexedDB.deleteDatabase(ISOLATED_DB)
    req.onsuccess = () => resolve()
    req.onerror = () => resolve()
  })
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

describe('ImportFromBrowserPanel (real IndexedDB)', () => {
  beforeEach(async () => {
    await clearDb()
    localStorage.removeItem('whiteboard.markdown-view-mode')
  })
  afterEach(cleanup)

  it('imports two seeded documents via daemonFetch without mutating the source IndexedDB store', async () => {
    const browserStore = new IdbDocumentIndex()
    await browserStore.createWorkspace({ workspaceId: 'local' })
    const loroStore = new LoroStore()

    const noDeltasId = (
      await browserStore.createDocument({
        workspaceId: 'local',
        path: 'no-deltas',
        name: 'No Deltas',
        kind: 'spatial',
      })
    ).documentId
    const withDeltasId = (
      await browserStore.createDocument({
        workspaceId: 'local',
        path: 'with-deltas',
        name: 'With Deltas',
        kind: 'spatial',
      })
    ).documentId

    const doc1 = new Loro()
    doc1.getMovableList('elements').push('one')
    doc1.commit()
    await loroStore.save(noDeltasId, doc1.export({ mode: 'snapshot' }))

    const doc2 = new Loro()
    doc2.getMovableList('elements').push('two-a')
    doc2.commit()
    await loroStore.save(withDeltasId, doc2.export({ mode: 'snapshot' }))
    const prevVV = doc2.version()
    doc2.getMovableList('elements').push('two-b')
    doc2.commit()
    await loroStore.appendDelta(withDeltasId, doc2.export({ mode: 'update', from: prevVV }))

    const documentsBefore = await listLocalDocuments(browserStore)
    const loro1Before = await loroStore.load(noDeltasId)
    const loro2Before = await loroStore.load(withDeltasId)

    const daemonFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/documents')) {
        const { path } = JSON.parse(init?.body as string) as { path: string }
        return jsonResponse({ path })
      }
      return jsonResponse({ ok: true })
    })

    render(
      <ImportFromBrowserPanel
        workspaceId="ws1"
        daemonFetch={daemonFetch}
        browserStore={browserStore}
        loroStore={loroStore}
        settingsStore={createUserSettingsStore()}
      />,
    )

    fireEvent.click(await screen.findByRole('button', { name: /import/i }))

    await screen.findByText(/^imported as no-deltas$/i)
    await screen.findByText(/^imported as with-deltas$/i)

    const createCalls = daemonFetch.mock.calls.filter(([input]) =>
      String(input).endsWith('/documents'),
    )
    const updateCalls = daemonFetch.mock.calls.filter(([input]) =>
      String(input).includes('/update'),
    )
    expect(createCalls).toHaveLength(2)
    expect(updateCalls).toHaveLength(2)

    const documentsAfter = await listLocalDocuments(browserStore)
    const loro1After = await loroStore.load(noDeltasId)
    const loro2After = await loroStore.load(withDeltasId)

    await waitFor(() => {
      expect(documentsAfter).toEqual(documentsBefore)
    })
    expect(loro1After).toEqual(loro1Before)
    expect(loro2After).toEqual(loro2Before)
  })
})
