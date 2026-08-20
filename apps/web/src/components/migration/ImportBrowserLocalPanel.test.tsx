import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { Loro } from 'loro-crdt'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LOCAL_WORKSPACE_ID } from '../../lib/local-document-summary.js'
import type { LoroLoadResult } from '../../lib/loro-store.js'
import { createUserSettingsStore } from '../../lib/user-settings-store.js'
import type { DocumentSnapshot } from '../../lib/whiteboard-client.js'
import { LocalStoreDouble } from '../../test-utils/local-index.js'
import { ImportBrowserLocalPanel } from './ImportBrowserLocalPanel.js'

// The panel loads a Loro snapshot by DOCUMENT ID and creates the destination
// by PATH, so a fixture has to pin both and the two must not be the same
// string — otherwise a test cannot tell which one a call site used.
//
// Written out rather than derived from the path: a derivation both produced
// non-ULIDs (`my-canvas` → a trailing `-`, which Crockford base32 has no
// symbol for) and collided any two paths sharing a prefix. LocalStoreDouble does
// not parse what it is given, so neither would have failed a test here — but
// LocalStoreDouble skips a row `documentSnapshotSchema` rejects, so the fixture
// would stop representing what production actually stores.
const DOCUMENT_IDS: Record<string, string> = {
  c1: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
  c2: '01ARZ3NDEKTSV4RRFFQ69G5FB0',
  'my-canvas': '01ARZ3NDEKTSV4RRFFQ69G5FC1',
}

function documentIdFor(path: string): string {
  const id = DOCUMENT_IDS[path]
  if (id === undefined) throw new Error(`no fixture id for path "${path}"`)
  return id
}

function makeCanvas(
  path: string,
  name: string,
  kind: DocumentSnapshot['kind'] = 'spatial',
): DocumentSnapshot {
  return {
    documentId: documentIdFor(path),
    workspaceId: LOCAL_WORKSPACE_ID,
    path,
    name,
    updatedAt: new Date().toISOString(),
    kind,
  }
}

function snapshotFor(tag: string): Uint8Array {
  const doc = new Loro()
  doc.getMovableList('elements').push(tag)
  doc.commit()
  return doc.export({ mode: 'snapshot' })
}

function makeLoroStore(byId: Record<string, LoroLoadResult>) {
  return { load: vi.fn(async (id: string) => byId[id] ?? { kind: 'not-found' as const }) }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

describe('ImportBrowserLocalPanel', () => {
  beforeEach(() => localStorage.clear())
  afterEach(cleanup)

  it('lists documents from the injected LocalStoreDouble', async () => {
    const store = new LocalStoreDouble()
    await store.save(makeCanvas('c1', 'Alpha'))
    await store.save(makeCanvas('c2', 'Beta'))

    render(
      <ImportBrowserLocalPanel
        workspaceId="ws1"
        daemonFetch={vi.fn()}
        browserLocalStore={store.index}
        browserLocalClock={store.clock}
        loroStore={makeLoroStore({})}
        settingsStore={createUserSettingsStore()}
      />,
    )

    await screen.findByText('Alpha')
    await screen.findByText('Beta')
  })

  it("threads each canvas's kind into the create request (markdown stays markdown)", async () => {
    const store = new LocalStoreDouble()
    await store.save(makeCanvas('c1', 'Notes', 'markdown'))
    const daemonFetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ path: 'notes' }))
      .mockResolvedValueOnce(jsonResponse({ ok: true }))

    render(
      <ImportBrowserLocalPanel
        workspaceId="ws1"
        daemonFetch={daemonFetch}
        browserLocalStore={store.index}
        browserLocalClock={store.clock}
        loroStore={makeLoroStore({
          [documentIdFor('c1')]: { kind: 'ok', snapshot: snapshotFor('c1') },
        })}
        settingsStore={createUserSettingsStore()}
      />,
    )

    await screen.findByText('Notes')
    fireEvent.click(screen.getByRole('button', { name: /import/i }))
    await waitFor(() => expect(daemonFetch).toHaveBeenCalled())
    const post = daemonFetch.mock.calls.find(
      ([url, init]) =>
        String(url).includes('/documents') && (init as RequestInit | undefined)?.method === 'POST',
    )
    expect(post).toBeTruthy()
    // biome is right that post?.[1] could be undefined in general; the toBeTruthy above plus the
    // non-null assertion (allowed by config) makes the intent explicit instead of casting past it.
    const init = post![1] as RequestInit
    expect(JSON.parse(String(init.body))).toEqual({
      path: expect.any(String),
      kind: 'markdown',
    })
  })

  it('renders an empty state, disables import, and makes zero calls when there are no documents', async () => {
    const daemonFetch = vi.fn()
    const settingsStore = createUserSettingsStore()
    const store = new LocalStoreDouble()
    render(
      <ImportBrowserLocalPanel
        workspaceId="ws1"
        daemonFetch={daemonFetch}
        browserLocalStore={store.index}
        browserLocalClock={store.clock}
        loroStore={makeLoroStore({})}
        settingsStore={settingsStore}
      />,
    )

    await screen.findByText(/no browser-local documents/i)
    expect(screen.queryByRole('button', { name: /import/i })).toBeNull()
    expect(daemonFetch).not.toHaveBeenCalled()
    expect(settingsStore.load().migration.browserLocalToDaemon?.lastImportedAt).toBeUndefined()
  })

  it('reports per-canvas success/failure and writes lastImportedAt only when >=1 succeeded', async () => {
    const store = new LocalStoreDouble()
    await store.save(makeCanvas('c1', 'Good'))
    await store.save(makeCanvas('c2', 'Bad'))

    const loroStore = makeLoroStore({
      [documentIdFor('c1')]: { kind: 'ok', snapshot: snapshotFor('good') },
      [documentIdFor('c2')]: { kind: 'not-found' },
    })

    const daemonFetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ path: 'good' }))
      .mockResolvedValueOnce(jsonResponse({ ok: true }))

    const settingsStore = createUserSettingsStore()

    render(
      <ImportBrowserLocalPanel
        workspaceId="ws1"
        daemonFetch={daemonFetch}
        browserLocalStore={store.index}
        browserLocalClock={store.clock}
        loroStore={loroStore}
        settingsStore={settingsStore}
      />,
    )

    fireEvent.click(await screen.findByRole('button', { name: /import/i }))

    await waitFor(() => expect(screen.getByText(/imported/i)).toBeTruthy())
    await screen.findByText(/canvas data was not found/i)

    expect(settingsStore.load().migration.browserLocalToDaemon?.lastImportedAt).toEqual(
      expect.any(String),
    )
  })

  it('recovers when a loro load throws mid-batch: later documents still import, button re-enables', async () => {
    const store = new LocalStoreDouble()
    await store.save(makeCanvas('c1', 'Thrower'))
    await store.save(makeCanvas('c2', 'Good'))

    const loroStore = {
      load: vi.fn(async (id: string) => {
        if (id === documentIdFor('c1')) throw new Error('IndexedDB read failed')
        return { kind: 'ok', snapshot: snapshotFor('good') } as LoroLoadResult
      }),
    }
    const daemonFetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ path: 'good' }))
      .mockResolvedValueOnce(jsonResponse({ ok: true }))
    const settingsStore = createUserSettingsStore()

    render(
      <ImportBrowserLocalPanel
        workspaceId="ws1"
        daemonFetch={daemonFetch}
        browserLocalStore={store.index}
        browserLocalClock={store.clock}
        loroStore={loroStore}
        settingsStore={settingsStore}
      />,
    )

    fireEvent.click(await screen.findByRole('button', { name: /import/i }))

    // c1 surfaces a per-canvas error, c2 still imports, and the button is
    // usable again (isImporting must not get stuck when an iteration throws).
    await screen.findByText(/imported as good/i)
    await waitFor(() =>
      expect((screen.getByRole('button', { name: /import/i }) as HTMLButtonElement).disabled).toBe(
        false,
      ),
    )
    expect(settingsStore.load().migration.browserLocalToDaemon?.lastImportedAt).toEqual(
      expect.any(String),
    )
  })

  it('shows the empty state instead of loading forever when listDocuments rejects', async () => {
    const store = new LocalStoreDouble()
    store.index.listDocuments = vi.fn().mockRejectedValue(new Error('IndexedDB blocked'))

    render(
      <ImportBrowserLocalPanel
        workspaceId="ws1"
        daemonFetch={vi.fn()}
        browserLocalStore={store.index}
        browserLocalClock={store.clock}
        loroStore={makeLoroStore({})}
        settingsStore={createUserSettingsStore()}
      />,
    )

    await screen.findByText(/no browser-local documents/i)
  })

  it('does not write lastImportedAt when every canvas fails', async () => {
    const store = new LocalStoreDouble()
    await store.save(makeCanvas('c1', 'Bad'))
    const loroStore = makeLoroStore({ [documentIdFor('c1')]: { kind: 'corrupt-snapshot' } })
    const settingsStore = createUserSettingsStore()

    render(
      <ImportBrowserLocalPanel
        workspaceId="ws1"
        daemonFetch={vi.fn()}
        browserLocalStore={store.index}
        browserLocalClock={store.clock}
        loroStore={loroStore}
        settingsStore={settingsStore}
      />,
    )

    fireEvent.click(await screen.findByRole('button', { name: /import/i }))
    await screen.findByText(/corrupted/i)

    expect(settingsStore.load().migration.browserLocalToDaemon?.lastImportedAt).toBeUndefined()
  })

  it('does not mutate the source store during import (copy-first)', async () => {
    const store = new LocalStoreDouble()
    await store.save(makeCanvas('c1', 'Alpha'))
    const before = await store.listDocuments()

    const daemonFetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ path: 'alpha' }))
      .mockResolvedValueOnce(jsonResponse({ ok: true }))

    render(
      <ImportBrowserLocalPanel
        workspaceId="ws1"
        daemonFetch={daemonFetch}
        browserLocalStore={store.index}
        browserLocalClock={store.clock}
        loroStore={makeLoroStore({
          [documentIdFor('c1')]: { kind: 'ok', snapshot: snapshotFor('alpha') },
        })}
        settingsStore={createUserSettingsStore()}
      />,
    )

    fireEvent.click(await screen.findByRole('button', { name: /import/i }))
    await waitFor(() => expect(screen.getByText(/imported/i)).toBeTruthy())

    const after = await store.listDocuments()
    expect(after).toEqual(before)
  })

  it('sidesteps a path the destination workspace already owns by suffixing it', async () => {
    // Two local documents can no longer collide with EACH OTHER — a local path
    // is unique in its own store. What still collides is the destination: the
    // daemon workspace may already hold a document at this path.
    const store = new LocalStoreDouble()
    await store.save(makeCanvas('my-canvas', 'My Canvas!'))

    const takenPaths = new Set<string>(['my-canvas'])
    const daemonFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/documents')) {
        const { path } = JSON.parse(init?.body as string) as { path: string }
        if (takenPaths.has(path)) return jsonResponse({ title: 'exists' }, 409)
        takenPaths.add(path)
        return jsonResponse({ path })
      }
      return jsonResponse({ ok: true })
    })

    render(
      <ImportBrowserLocalPanel
        workspaceId="ws1"
        daemonFetch={daemonFetch}
        browserLocalStore={store.index}
        browserLocalClock={store.clock}
        loroStore={makeLoroStore({
          [documentIdFor('my-canvas')]: { kind: 'ok', snapshot: snapshotFor('a') },
        })}
        settingsStore={createUserSettingsStore()}
      />,
    )

    fireEvent.click(await screen.findByRole('button', { name: /import/i }))
    await screen.findByText(/^imported as my-canvas-2$/i)
  })
})
