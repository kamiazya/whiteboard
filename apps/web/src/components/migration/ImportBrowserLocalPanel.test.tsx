import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { Loro } from 'loro-crdt'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryStore } from '../../lib/browser-local-store.js'
import type { LoroLoadResult } from '../../lib/loro-store.js'
import { createUserSettingsStore } from '../../lib/user-settings-store.js'
import type { CanvasSnapshot } from '../../lib/whiteboard-client.js'
import { ImportBrowserLocalPanel } from './ImportBrowserLocalPanel.js'

function makeCanvas(id: string, name: string): CanvasSnapshot {
  return { id, name, updatedAt: new Date().toISOString(), kind: 'spatial' as const }
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

  it('lists canvases from the injected BrowserLocalStore', async () => {
    const store = new MemoryStore()
    await store.save(makeCanvas('c1', 'Alpha'))
    await store.save(makeCanvas('c2', 'Beta'))

    render(
      <ImportBrowserLocalPanel
        workspaceId="ws1"
        daemonFetch={vi.fn()}
        browserLocalStore={store}
        loroStore={makeLoroStore({})}
        settingsStore={createUserSettingsStore()}
      />,
    )

    await screen.findByText('Alpha')
    await screen.findByText('Beta')
  })

  it('renders an empty state, disables import, and makes zero calls when there are no canvases', async () => {
    const daemonFetch = vi.fn()
    const settingsStore = createUserSettingsStore()
    render(
      <ImportBrowserLocalPanel
        workspaceId="ws1"
        daemonFetch={daemonFetch}
        browserLocalStore={new MemoryStore()}
        loroStore={makeLoroStore({})}
        settingsStore={settingsStore}
      />,
    )

    await screen.findByText(/no browser-local canvases/i)
    expect(screen.queryByRole('button', { name: /import/i })).toBeNull()
    expect(daemonFetch).not.toHaveBeenCalled()
    expect(settingsStore.load().migration.browserLocalToDaemon?.lastImportedAt).toBeUndefined()
  })

  it('reports per-canvas success/failure and writes lastImportedAt only when >=1 succeeded', async () => {
    const store = new MemoryStore()
    await store.save(makeCanvas('c1', 'Good'))
    await store.save(makeCanvas('c2', 'Bad'))

    const loroStore = makeLoroStore({
      c1: { kind: 'ok', snapshot: snapshotFor('good') },
      c2: { kind: 'not-found' },
    })

    const daemonFetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ slug: 'good' }))
      .mockResolvedValueOnce(jsonResponse({ ok: true }))

    const settingsStore = createUserSettingsStore()

    render(
      <ImportBrowserLocalPanel
        workspaceId="ws1"
        daemonFetch={daemonFetch}
        browserLocalStore={store}
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

  it('recovers when a loro load throws mid-batch: later canvases still import, button re-enables', async () => {
    const store = new MemoryStore()
    await store.save(makeCanvas('c1', 'Thrower'))
    await store.save(makeCanvas('c2', 'Good'))

    const loroStore = {
      load: vi.fn(async (id: string) => {
        if (id === 'c1') throw new Error('IndexedDB read failed')
        return { kind: 'ok', snapshot: snapshotFor('good') } as LoroLoadResult
      }),
    }
    const daemonFetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ slug: 'good' }))
      .mockResolvedValueOnce(jsonResponse({ ok: true }))
    const settingsStore = createUserSettingsStore()

    render(
      <ImportBrowserLocalPanel
        workspaceId="ws1"
        daemonFetch={daemonFetch}
        browserLocalStore={store}
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

  it('shows the empty state instead of loading forever when listCanvases rejects', async () => {
    const store = new MemoryStore()
    store.listCanvases = vi.fn().mockRejectedValue(new Error('IndexedDB blocked'))

    render(
      <ImportBrowserLocalPanel
        workspaceId="ws1"
        daemonFetch={vi.fn()}
        browserLocalStore={store}
        loroStore={makeLoroStore({})}
        settingsStore={createUserSettingsStore()}
      />,
    )

    await screen.findByText(/no browser-local canvases/i)
  })

  it('does not write lastImportedAt when every canvas fails', async () => {
    const store = new MemoryStore()
    await store.save(makeCanvas('c1', 'Bad'))
    const loroStore = makeLoroStore({ c1: { kind: 'corrupt-snapshot' } })
    const settingsStore = createUserSettingsStore()

    render(
      <ImportBrowserLocalPanel
        workspaceId="ws1"
        daemonFetch={vi.fn()}
        browserLocalStore={store}
        loroStore={loroStore}
        settingsStore={settingsStore}
      />,
    )

    fireEvent.click(await screen.findByRole('button', { name: /import/i }))
    await screen.findByText(/corrupted/i)

    expect(settingsStore.load().migration.browserLocalToDaemon?.lastImportedAt).toBeUndefined()
  })

  it('does not mutate the source store during import (copy-first)', async () => {
    const store = new MemoryStore()
    await store.save(makeCanvas('c1', 'Alpha'))
    const before = await store.listCanvases()

    const daemonFetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ slug: 'alpha' }))
      .mockResolvedValueOnce(jsonResponse({ ok: true }))

    render(
      <ImportBrowserLocalPanel
        workspaceId="ws1"
        daemonFetch={daemonFetch}
        browserLocalStore={store}
        loroStore={makeLoroStore({ c1: { kind: 'ok', snapshot: snapshotFor('alpha') } })}
        settingsStore={createUserSettingsStore()}
      />,
    )

    fireEvent.click(await screen.findByRole('button', { name: /import/i }))
    await waitFor(() => expect(screen.getByText(/imported/i)).toBeTruthy())

    const after = await store.listCanvases()
    expect(after).toEqual(before)
  })

  it('imports two same-named canvases sequentially with distinct destination slugs on 409', async () => {
    const store = new MemoryStore()
    await store.save(makeCanvas('c1', 'My Canvas!'))
    await store.save(makeCanvas('c2', 'My Canvas!'))

    const takenSlugs = new Set<string>()
    const daemonFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/canvases')) {
        const { slug } = JSON.parse(init?.body as string) as { slug: string }
        if (takenSlugs.has(slug)) return jsonResponse({ title: 'exists' }, 409)
        takenSlugs.add(slug)
        return jsonResponse({ slug })
      }
      return jsonResponse({ ok: true })
    })

    render(
      <ImportBrowserLocalPanel
        workspaceId="ws1"
        daemonFetch={daemonFetch}
        browserLocalStore={store}
        loroStore={makeLoroStore({
          c1: { kind: 'ok', snapshot: snapshotFor('a') },
          c2: { kind: 'ok', snapshot: snapshotFor('b') },
        })}
        settingsStore={createUserSettingsStore()}
      />,
    )

    fireEvent.click(await screen.findByRole('button', { name: /import/i }))

    await screen.findByText(/^imported as my-canvas$/i)
    await screen.findByText(/^imported as my-canvas-2$/i)
  })
})
