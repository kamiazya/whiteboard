/**
 * Real-IndexedDB browser test: seeds the actual IdbDocumentIndex + LoroStore
 * with two documents (one with deltas), imports both, and asserts copy-first
 * — after import the source store's contents are byte-identical.
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { Loro } from 'loro-crdt'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IdbDocumentIndex } from '../../lib/idb-document-index.js'
import { listLocalDocuments } from '../../lib/local-document-summary.js'
import { LoroStore } from '../../lib/loro-store.js'
import { createUserSettingsStore } from '../../lib/user-settings-store.js'
import { ImportBrowserLocalPanel } from './ImportBrowserLocalPanel.js'

async function clearDb(): Promise<void> {
  return new Promise((resolve) => {
    const req = indexedDB.deleteDatabase('whiteboard')
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

describe('ImportBrowserLocalPanel (real IndexedDB)', () => {
  beforeEach(async () => {
    await clearDb()
    localStorage.clear()
  })
  afterEach(cleanup)

  it('imports two seeded documents via daemonFetch without mutating the source IndexedDB store', async () => {
    const browserLocalStore = new IdbDocumentIndex()
    await browserLocalStore.createWorkspace({ workspaceId: 'local' })
    const loroStore = new LoroStore()

    const noDeltasId = (
      await browserLocalStore.createDocument({
        workspaceId: 'local',
        path: 'no-deltas',
        name: 'No Deltas',
        kind: 'spatial',
      })
    ).documentId
    const withDeltasId = (
      await browserLocalStore.createDocument({
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

    const documentsBefore = await listLocalDocuments(browserLocalStore)
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
      <ImportBrowserLocalPanel
        workspaceId="ws1"
        daemonFetch={daemonFetch}
        browserLocalStore={browserLocalStore}
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

    const documentsAfter = await listLocalDocuments(browserLocalStore)
    const loro1After = await loroStore.load(noDeltasId)
    const loro2After = await loroStore.load(withDeltasId)

    await waitFor(() => {
      expect(documentsAfter).toEqual(documentsBefore)
    })
    expect(loro1After).toEqual(loro1Before)
    expect(loro2After).toEqual(loro2Before)
  })
})
