/**
 * Real-IndexedDB browser test: seeds the actual IndexedDBStore + LoroStore
 * with two documents (one with deltas), imports both, and asserts copy-first
 * — after import the source store's contents are byte-identical.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { Loro } from 'loro-crdt'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IndexedDBStore } from '../../lib/browser-local-store.js'
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
    const browserLocalStore = new IndexedDBStore()
    const loroStore = new LoroStore()

    await browserLocalStore.save({
      documentId: '0Y147ADGKPSWZ258BEHMQTX036',
      workspaceId: 'local',
      path: 'no-deltas',
      name: 'No Deltas',
      updatedAt: '2026-01-01T00:00:00.000Z',
      kind: 'spatial' as const,
    })
    await browserLocalStore.save({
      documentId: '058BEHMQTX0369CFJNRVY147AD',
      workspaceId: 'local',
      path: 'with-deltas',
      name: 'With Deltas',
      updatedAt: '2026-01-02T00:00:00.000Z',
      kind: 'spatial' as const,
    })

    const doc1 = new Loro()
    doc1.getMovableList('elements').push('one')
    doc1.commit()
    await loroStore.save('0Y147ADGKPSWZ258BEHMQTX036', doc1.export({ mode: 'snapshot' }))

    const doc2 = new Loro()
    doc2.getMovableList('elements').push('two-a')
    doc2.commit()
    await loroStore.save('058BEHMQTX0369CFJNRVY147AD', doc2.export({ mode: 'snapshot' }))
    const prevVV = doc2.version()
    doc2.getMovableList('elements').push('two-b')
    doc2.commit()
    await loroStore.appendDelta(
      '058BEHMQTX0369CFJNRVY147AD',
      doc2.export({ mode: 'update', from: prevVV }),
    )

    const documentsBefore = await browserLocalStore.listDocuments()
    const loro1Before = await loroStore.load('0Y147ADGKPSWZ258BEHMQTX036')
    const loro2Before = await loroStore.load('058BEHMQTX0369CFJNRVY147AD')

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

    const documentsAfter = await browserLocalStore.listDocuments()
    const loro1After = await loroStore.load('0Y147ADGKPSWZ258BEHMQTX036')
    const loro2After = await loroStore.load('058BEHMQTX0369CFJNRVY147AD')

    await waitFor(() => {
      expect(documentsAfter).toEqual(documentsBefore)
    })
    expect(loro1After).toEqual(loro1Before)
    expect(loro2After).toEqual(loro2Before)
  })
})
