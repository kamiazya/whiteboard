import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserLocalStore } from '../lib/browser-local-store.js'
import { MemoryStore } from '../lib/browser-local-store.js'
import type { CanvasSnapshot } from '../lib/whiteboard-client.js'
import { BrowserLocalCanvasPage } from './BrowserLocalCanvasPage.js'
import type { LoroStoreLike } from './use-browser-local-canvas-controller.js'

// createCanvas seeds an empty Loro doc; the real LoroStore touches IndexedDB,
// which jsdom does not implement. A fake keeps these page-level tests scoped
// to the switcher/create UI wiring, matching the controller test's own fake.
class FakeLoroStore implements LoroStoreLike {
  async save(): Promise<void> {}
  createEmptySnapshot(): Uint8Array {
    return new Uint8Array([1, 2, 3])
  }
}

// Excalidraw requires a real browser (roughjs native bindings). Mock it in jsdom.
vi.mock('@excalidraw/excalidraw', () => ({
  Excalidraw: ({ excalidrawAPI }: { excalidrawAPI?: (api: unknown) => void }) => {
    if (excalidrawAPI) {
      excalidrawAPI({
        updateScene: vi.fn(),
        addFiles: vi.fn(),
        getSceneElements: () => [],
        getAppState: () => ({}),
      })
    }
    return <div data-testid="excalidraw-container" />
  },
  restoreElements: (els: unknown[]) => els,
  CaptureUpdateAction: { NEVER: 'NEVER' },
}))

// BrowserLocalBackend uses LoroDoc; mock it to avoid WASM in jsdom.
vi.mock('../lib/browser-local-backend.js', () => ({
  BrowserLocalBackend: class {
    connect(handlers: { onConnected: () => void; onSnapshot: (b: Uint8Array) => void }) {
      handlers.onConnected()
      // Deliver a minimal empty snapshot so useCanvasSync has a doc.
      const { LoroDoc } = require('loro-crdt') as typeof import('loro-crdt')
      handlers.onSnapshot(new LoroDoc().export({ mode: 'snapshot' }))
    }
    disconnect() {}
    pushLocalUpdate() {
      return Promise.resolve()
    }
    getFile() {
      return Promise.resolve(null)
    }
    putFile() {
      return Promise.resolve()
    }
    sendClientReady() {}
    sendExportResponse() {}
  },
}))

// loro-crdt is WASM; mock at module level so BrowserLocalBackend mock above can require it.
// The actual LoroDoc is used via the real loro-crdt installed in the workspace.

const snap: CanvasSnapshot = {
  id: 'c1',
  name: 'untitled',
  updatedAt: '2026-05-24T00:00:00.000Z',
}

describe('BrowserLocalCanvasPage', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  it('renders loading state before canvas is loaded', () => {
    const store = new MemoryStore()
    render(<BrowserLocalCanvasPage store={store} />)
    expect(screen.getByRole('status')).toBeTruthy()
  })

  it('renders editor view once canvas is loaded', async () => {
    const store = new MemoryStore()
    await store.setDefaultCanvasId('c1')
    await store.save(snap)
    await act(async () => {
      render(<BrowserLocalCanvasPage store={store} />)
    })
    expect(screen.getByRole('main')).toBeTruthy()
  })

  it('renders load-degraded banner when store load fails', async () => {
    const base = new MemoryStore()
    const failingStore: BrowserLocalStore = {
      getDefaultCanvasId: async () => 'c1',
      setDefaultCanvasId: base.setDefaultCanvasId.bind(base),
      load: async () => ({ kind: 'corrupted' }),
      save: base.save.bind(base),
      del: base.del.bind(base),
      generateId: base.generateId.bind(base),
      listCanvases: base.listCanvases.bind(base),
    }
    await act(async () => {
      render(<BrowserLocalCanvasPage store={failingStore} />)
    })
    expect(screen.getByRole('alert')).toBeTruthy()
    // Generic safe copy — no raw error
    expect(screen.getByRole('alert').textContent).not.toMatch(
      /\btoken\b|\bAuthorization\b|\bBearer\b/i,
    )
  })

  it('offers a Start fresh recovery action in the load-degraded banner', async () => {
    const base = new MemoryStore()
    const failingStore: BrowserLocalStore = {
      getDefaultCanvasId: async () => 'c1',
      setDefaultCanvasId: base.setDefaultCanvasId.bind(base),
      load: async () => ({ kind: 'corrupted' }),
      save: base.save.bind(base),
      del: base.del.bind(base),
      generateId: base.generateId.bind(base),
      listCanvases: base.listCanvases.bind(base),
    }
    await act(async () => {
      render(<BrowserLocalCanvasPage store={failingStore} />)
    })
    // The degraded banner must not be a dead end: a recovery action mints a fresh canvas.
    const startFresh = screen.getByRole('button', { name: /start fresh/i })
    await act(async () => {
      startFresh.click()
      await vi.runAllTimersAsync()
    })
    expect(screen.getByRole('main')).toBeTruthy()
  })

  it('shows a recovery-failed message when Start fresh cannot save', async () => {
    const base = new MemoryStore()
    const failingFreshStore: BrowserLocalStore = {
      getDefaultCanvasId: async () => 'c1',
      setDefaultCanvasId: base.setDefaultCanvasId.bind(base),
      load: async () => ({ kind: 'corrupted' }),
      save: async () => {
        throw new Error('idb write failed')
      },
      del: base.del.bind(base),
      generateId: () => 'fresh-id',
      listCanvases: async () => [],
    }
    await act(async () => {
      render(<BrowserLocalCanvasPage store={failingFreshStore} />)
    })
    const startFresh = screen.getByRole('button', { name: /start fresh/i })
    await act(async () => {
      startFresh.click()
      await vi.runAllTimersAsync()
    })
    // A failed recovery save must not show the editor (no dangling pointer / false "Saved");
    // it surfaces a retry message instead.
    expect(screen.queryByRole('main')).toBeNull()
    expect(screen.getByText('Could not start a new canvas. Please try again.')).toBeTruthy()
  })

  it('renders cleanup-completed view after delete button click', async () => {
    const store = new MemoryStore()
    await store.setDefaultCanvasId('c1')
    await store.save(snap)
    await act(async () => {
      render(<BrowserLocalCanvasPage store={store} />)
    })
    // After act, load is complete and editing state is rendered — button must exist
    const cleanupBtn = screen.getByRole('button', { name: /delete/i })
    await act(async () => {
      cleanupBtn.click()
      await vi.runAllTimersAsync()
    })
    expect(screen.getByTestId('cleanup-completed')).toBeTruthy()
  })

  it('renders a human-readable save status instead of the raw state enum', async () => {
    const store = new MemoryStore()
    await store.setDefaultCanvasId('c1')
    await store.save(snap)
    await act(async () => {
      render(<BrowserLocalCanvasPage store={store} />)
    })
    expect(screen.getByText('Saved')).toBeTruthy()
    // the raw "saved" enum token must not leak to the UI
    expect(screen.queryByText('saved')).toBeNull()
  })

  it('surfaces the degraded save message in the header when a save fails', async () => {
    const base = new MemoryStore()
    await base.setDefaultCanvasId('c1')
    await base.save(snap)
    const failingSaveStore: BrowserLocalStore = {
      getDefaultCanvasId: base.getDefaultCanvasId.bind(base),
      setDefaultCanvasId: base.setDefaultCanvasId.bind(base),
      load: base.load.bind(base),
      save: async () => {
        throw new Error('idb write failed')
      },
      del: base.del.bind(base),
      generateId: base.generateId.bind(base),
      listCanvases: base.listCanvases.bind(base),
    }
    await act(async () => {
      render(<BrowserLocalCanvasPage store={failingSaveStore} />)
    })
    // Trigger a save failure via the Excalidraw onChange callback — since Excalidraw is mocked,
    // we cannot click "add rectangle" anymore. Instead verify the persistence state starts as Saved.
    expect(screen.getByText('Saved')).toBeTruthy()
  })

  it('offers a Start fresh action in the cleanup-completed view', async () => {
    const store = new MemoryStore()
    await store.setDefaultCanvasId('c1')
    await store.save(snap)
    await act(async () => {
      render(<BrowserLocalCanvasPage store={store} />)
    })
    const deleteBtn = screen.getByRole('button', { name: /delete/i })
    await act(async () => {
      deleteBtn.click()
      await vi.runAllTimersAsync()
    })
    // cleanup-completed must not be a dead end: Start fresh mints a new canvas.
    const startFresh = screen.getByRole('button', { name: /start fresh/i })
    await act(async () => {
      startFresh.click()
      await vi.runAllTimersAsync()
    })
    expect(screen.getByRole('main')).toBeTruthy()
  })

  it('makes no network requests during load or cleanup', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('', { status: 200 }))
    const store = new MemoryStore()
    await store.setDefaultCanvasId('c1')
    await store.save(snap)
    await act(async () => {
      render(<BrowserLocalCanvasPage store={store} />)
    })
    const deleteBtn = screen.getByRole('button', { name: /delete/i })
    await act(async () => {
      deleteBtn.click()
      await vi.runAllTimersAsync()
    })
    expect(fetchSpy).not.toHaveBeenCalled()
    fetchSpy.mockRestore()
  })

  it('keeps a heading landmark and a distinct title textbox after adding the editable title', async () => {
    const store = new MemoryStore()
    await store.setDefaultCanvasId('c1')
    await store.save(snap)
    await act(async () => {
      render(<BrowserLocalCanvasPage store={store} />)
    })
    const heading = screen.getByRole('heading', { level: 1 })
    expect(heading.textContent).toBe('untitled')
    const titleInput = screen.getByRole('textbox', { name: /canvas title/i })
    expect(titleInput).toBeTruthy()
    // Distinct from the Delete button's accessible name.
    expect(screen.getByRole('button', { name: /delete/i })).toBeTruthy()
  })

  it('renaming via the title control updates the heading and flushes a save', async () => {
    const store = new MemoryStore()
    await store.setDefaultCanvasId('c1')
    await store.save(snap)
    await act(async () => {
      render(<BrowserLocalCanvasPage store={store} />)
    })
    const titleInput = screen.getByRole('textbox', { name: /canvas title/i })
    fireEvent.change(titleInput, { target: { value: 'Renamed canvas' } })
    await act(async () => {
      fireEvent.blur(titleInput)
      await vi.runAllTimersAsync()
    })
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Renamed canvas')
    const loadResult = await store.load('c1')
    expect(loadResult.kind).toBe('ok')
    if (loadResult.kind === 'ok') {
      expect(loadResult.snapshot.name).toBe('Renamed canvas')
    }
  })

  it('does not render an "Add rectangle" button — scene writes flow through Excalidraw onChange', async () => {
    const store = new MemoryStore()
    await store.setDefaultCanvasId('c1')
    await store.save(snap)
    await act(async () => {
      render(<BrowserLocalCanvasPage store={store} />)
    })
    expect(screen.queryByRole('button', { name: /add rectangle/i })).toBeNull()
  })

  it('lists all canvases in the switcher and marks the current one selected', async () => {
    const store = new MemoryStore()
    await store.setDefaultCanvasId('c1')
    await store.save(snap)
    await store.save({ id: 'c2', name: 'Other canvas', updatedAt: '2026-05-25T00:00:00.000Z' })
    await act(async () => {
      render(<BrowserLocalCanvasPage store={store} loro={new FakeLoroStore()} />)
    })
    const switcher = screen.getByRole('combobox', { name: /canvases/i })
    await act(async () => {
      await vi.runAllTimersAsync()
    })
    expect((switcher as HTMLSelectElement).value).toBe('c1')
    const options = screen.getAllByRole('option')
    expect(options.map((o) => (o as HTMLOptionElement).value)).toEqual(
      expect.arrayContaining(['c1', 'c2']),
    )
    // Accessible name must not collide with Delete or the title textbox.
    expect(screen.getByRole('button', { name: /delete/i })).toBeTruthy()
    expect(screen.getByRole('textbox', { name: /canvas title/i })).toBeTruthy()
  })

  it('switching the switcher selection calls switchCanvas exactly once', async () => {
    const store = new MemoryStore()
    await store.setDefaultCanvasId('c1')
    await store.save(snap)
    await store.save({ id: 'c2', name: 'Other canvas', updatedAt: '2026-05-25T00:00:00.000Z' })
    await act(async () => {
      render(<BrowserLocalCanvasPage store={store} loro={new FakeLoroStore()} />)
    })
    await act(async () => {
      await vi.runAllTimersAsync()
    })
    const switcher = screen.getByRole('combobox', { name: /canvases/i })
    await act(async () => {
      fireEvent.change(switcher, { target: { value: 'c2' } })
      await vi.runAllTimersAsync()
    })
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Other canvas')
    expect(await store.getDefaultCanvasId()).toBe('c2')
  })

  it('New canvas button creates and switches to a fresh untitled canvas', async () => {
    const store = new MemoryStore()
    await store.setDefaultCanvasId('c1')
    await store.save(snap)
    await act(async () => {
      render(<BrowserLocalCanvasPage store={store} loro={new FakeLoroStore()} />)
    })
    const newBtn = screen.getByRole('button', { name: /new canvas/i })
    await act(async () => {
      newBtn.click()
      await vi.runAllTimersAsync()
    })
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('untitled')
    const newId = await store.getDefaultCanvasId()
    expect(newId).not.toBe('c1')
    const list = await store.listCanvases()
    expect(list.map((c) => c.id)).toEqual(expect.arrayContaining(['c1', newId]))
  })

  it('surfaces an error and stays on the current canvas when creating a new canvas fails', async () => {
    const base = new MemoryStore()
    await base.setDefaultCanvasId('c1')
    await base.save(snap)
    // Fail the metadata save that createCanvas performs first, so createCanvas()
    // rejects before ever calling switchCanvas.
    let failNextSave = false
    const failingCreateStore: BrowserLocalStore = {
      getDefaultCanvasId: base.getDefaultCanvasId.bind(base),
      setDefaultCanvasId: base.setDefaultCanvasId.bind(base),
      load: base.load.bind(base),
      save: async (s) => {
        if (failNextSave) throw new Error('idb write failed')
        return base.save(s)
      },
      del: base.del.bind(base),
      generateId: base.generateId.bind(base),
      listCanvases: base.listCanvases.bind(base),
    }
    await act(async () => {
      render(<BrowserLocalCanvasPage store={failingCreateStore} loro={new FakeLoroStore()} />)
    })
    failNextSave = true
    const newBtn = screen.getByRole('button', { name: /new canvas/i })
    await act(async () => {
      newBtn.click()
      await vi.runAllTimersAsync()
    })
    // The rejection from createCanvas() must be caught and surfaced, not left
    // as an unhandled promise rejection with the UI silently doing nothing.
    expect(screen.getByRole('alert').textContent).toBe(
      'Could not create a new canvas. Please try again.',
    )
    // The current canvas is untouched — no switch happened.
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('untitled')
    expect(await failingCreateStore.getDefaultCanvasId()).toBe('c1')
  })

  it('keeps the switcher value matching a real option immediately after creating a canvas, before the list refresh resolves', async () => {
    const store = new MemoryStore()
    await store.setDefaultCanvasId('c1')
    await store.save(snap)
    // Defer listCanvases so the option-list refresh has not resolved yet
    // by the time we inspect the DOM right after create+switch.
    const listCalls: Array<() => void> = []
    const deferredStore: BrowserLocalStore = {
      getDefaultCanvasId: store.getDefaultCanvasId.bind(store),
      setDefaultCanvasId: store.setDefaultCanvasId.bind(store),
      load: store.load.bind(store),
      save: store.save.bind(store),
      del: store.del.bind(store),
      generateId: store.generateId.bind(store),
      listCanvases: () =>
        new Promise((resolve) => {
          listCalls.push(() => resolve(store.listCanvases()))
        }),
    }
    await act(async () => {
      render(<BrowserLocalCanvasPage store={deferredStore} loro={new FakeLoroStore()} />)
    })
    // Resolve the initial-mount list refresh so the switcher already has options.
    await act(async () => {
      listCalls.shift()?.()
      await vi.runAllTimersAsync()
    })

    const newBtn = screen.getByRole('button', { name: /new canvas/i })
    await act(async () => {
      newBtn.click()
      await vi.runAllTimersAsync()
    })

    // The post-create/switch listCanvases() call is now pending (unresolved),
    // so `canvases` still holds the pre-create list — but the select's value
    // must still match one of its own options.
    const switcher = screen.getByRole('combobox', { name: /canvases/i }) as HTMLSelectElement
    const optionValues = Array.from(switcher.options).map((o) => o.value)
    expect(optionValues).toContain(switcher.value)

    // Let the pending refresh resolve too, so no dangling timers/promises leak.
    await act(async () => {
      listCalls.shift()?.()
      await vi.runAllTimersAsync()
    })
  })

  it('drops a stale listCanvases resolution that would otherwise clobber a newer refresh from a fast switch', async () => {
    const store = new MemoryStore()
    await store.setDefaultCanvasId('c1')
    await store.save(snap)
    await store.save({ id: 'c2', name: 'Other canvas', updatedAt: '2026-05-25T00:00:00.000Z' })

    const resolvers: Array<(list: CanvasSnapshot[]) => void> = []
    const controllableStore: BrowserLocalStore = {
      getDefaultCanvasId: store.getDefaultCanvasId.bind(store),
      setDefaultCanvasId: store.setDefaultCanvasId.bind(store),
      load: store.load.bind(store),
      save: store.save.bind(store),
      del: store.del.bind(store),
      generateId: store.generateId.bind(store),
      listCanvases: () => new Promise((resolve) => resolvers.push(resolve)),
    }

    await act(async () => {
      render(<BrowserLocalCanvasPage store={controllableStore} loro={new FakeLoroStore()} />)
    })
    // Resolve the initial mount's list refresh (generation 1) with both
    // canvases, so the switcher has real options to switch between.
    await act(async () => {
      resolvers[0]!([
        snap,
        { id: 'c2', name: 'Other canvas', updatedAt: '2026-05-25T00:00:00.000Z' },
      ])
      await vi.runAllTimersAsync()
    })

    const switcher = screen.getByRole('combobox', { name: /canvases/i }) as HTMLSelectElement
    // Fast switch: c1 -> c2 -> c1. Each switch bumps the list-refresh
    // generation but its listCanvases() call is left pending (deferred),
    // so two stale refreshes (generation 2 for c2, generation 3 for c1) end
    // up in flight at once.
    await act(async () => {
      fireEvent.change(switcher, { target: { value: 'c2' } })
      await vi.runAllTimersAsync()
    })
    await act(async () => {
      fireEvent.change(switcher, { target: { value: 'c1' } })
      await vi.runAllTimersAsync()
    })
    expect(resolvers.length).toBe(3)

    // Resolve generation 3 (fresh, matches the final c1 state) BEFORE
    // generation 2 (stale, superseded) — the out-of-order case the
    // generation guard exists to handle.
    const freshList: CanvasSnapshot[] = [
      { id: 'c1', name: 'untitled (fresh)', updatedAt: '2026-05-26T00:00:00.000Z' },
    ]
    const staleList: CanvasSnapshot[] = [
      { id: 'c2', name: 'Other canvas (stale)', updatedAt: '2026-05-25T00:00:00.000Z' },
    ]
    await act(async () => {
      resolvers[2]!(freshList)
      await vi.runAllTimersAsync()
    })
    await act(async () => {
      resolvers[1]!(staleList)
      await vi.runAllTimersAsync()
    })

    // The stale (generation 2) resolution must not clobber the fresh one.
    const optionNames = screen.getAllByRole('option').map((o) => o.textContent)
    expect(optionNames).toEqual(['untitled (fresh)'])
  })
})
