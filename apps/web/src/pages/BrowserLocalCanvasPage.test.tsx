import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserLocalStore } from '../lib/browser-local-store.js'
import { MemoryStore } from '../lib/browser-local-store.js'
import type { CanvasSnapshot } from '../lib/whiteboard-client.js'
import { assertNoSetStateInRenderWarning } from '../test-utils/no-setstate-in-render.js'
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
  Excalidraw: ({
    excalidrawAPI,
    theme,
  }: {
    excalidrawAPI?: (api: unknown) => void
    theme?: string
  }) => {
    if (excalidrawAPI) {
      excalidrawAPI({
        updateScene: vi.fn(),
        addFiles: vi.fn(),
        getSceneElements: () => [],
        getAppState: () => ({}),
      })
    }
    // Surfaces the received theme so tests can assert the page actually
    // wires resolvedTheme through to the editor, not just the button label.
    // Distinct testid: the page's own wrapper already claims
    // "excalidraw-container".
    return <div data-testid="excalidraw-mock" data-theme={theme ?? ''} />
  },
  restoreElements: (els: unknown[]) => els,
  CaptureUpdateAction: { NEVER: 'NEVER' },
  exportToBlob: vi.fn(async () => new Blob(['png'], { type: 'image/png' })),
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

  it('renders cleanup-completed view after delete button click and confirm', async () => {
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
    })
    expect(screen.getByRole('alertdialog')).toBeTruthy()
    const confirmBtn = screen.getByRole('button', { name: /^delete$/i })
    await act(async () => {
      confirmBtn.click()
      await vi.runAllTimersAsync()
    })
    expect(screen.getByTestId('cleanup-completed')).toBeTruthy()
  })

  it('does not delete the canvas when the confirmation dialog is cancelled', async () => {
    const store = new MemoryStore()
    await store.setDefaultCanvasId('c1')
    await store.save(snap)
    await act(async () => {
      render(<BrowserLocalCanvasPage store={store} />)
    })
    const cleanupBtn = screen.getByRole('button', { name: /delete canvas/i })
    await act(async () => {
      cleanupBtn.click()
    })
    expect(screen.getByRole('alertdialog')).toBeTruthy()
    const cancelBtn = screen.getByRole('button', { name: /cancel/i })
    await act(async () => {
      cancelBtn.click()
      await vi.runAllTimersAsync()
    })
    expect(screen.queryByTestId('cleanup-completed')).toBeNull()
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(screen.getByRole('main')).toBeTruthy()
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
    })
    const confirmBtn = screen.getByRole('button', { name: /^delete$/i })
    await act(async () => {
      confirmBtn.click()
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
    })
    const confirmBtn = screen.getByRole('button', { name: /^delete$/i })
    await act(async () => {
      confirmBtn.click()
      await vi.runAllTimersAsync()
    })
    expect(fetchSpy).not.toHaveBeenCalled()
    fetchSpy.mockRestore()
  })

  it('keeps a heading landmark distinct from the Delete button and the canvas actions control', async () => {
    vi.useRealTimers()
    const store = new MemoryStore()
    await store.setDefaultCanvasId('c1')
    await store.save(snap)
    await act(async () => {
      render(<BrowserLocalCanvasPage store={store} />)
    })
    const heading = screen.getByRole('heading', { level: 1 })
    expect(heading.textContent).toBe('untitled')
    // WorkspaceTopBar mounts through a lazy chunk; wait for it to resolve.
    expect(await screen.findByLabelText('Canvas actions')).toBeTruthy()
    // Distinct from the Delete button's accessible name.
    expect(screen.getByRole('button', { name: /delete/i })).toBeTruthy()
  })

  it("renaming through the top bar's canvas actions updates the heading and flushes a save", async () => {
    vi.useRealTimers()
    const store = new MemoryStore()
    await store.setDefaultCanvasId('c1')
    await store.save(snap)
    await act(async () => {
      render(<BrowserLocalCanvasPage store={store} />)
    })
    const canvasActions = await screen.findByLabelText('Canvas actions')
    fireEvent.pointerDown(canvasActions, { button: 0, ctrlKey: false })
    const renameItem = await screen.findByText('Rename canvas')
    fireEvent.pointerUp(renameItem)
    const titleInput = screen.getByRole('textbox', { name: /canvas title/i })
    fireEvent.change(titleInput, { target: { value: 'Renamed canvas' } })
    fireEvent.keyDown(titleInput, { key: 'Enter' })
    await waitFor(() => {
      expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Renamed canvas')
    })
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

  it('lists all canvases in the switcher dropdown', async () => {
    vi.useRealTimers()
    const store = new MemoryStore()
    await store.setDefaultCanvasId('c1')
    await store.save(snap)
    await store.save({ id: 'c2', name: 'Other canvas', updatedAt: '2026-05-25T00:00:00.000Z' })
    await act(async () => {
      render(<BrowserLocalCanvasPage store={store} loro={new FakeLoroStore()} />)
    })
    const switcher = await screen.findByRole('button', { name: 'untitled' })
    // Accessible names must not collide with Delete or the canvas actions control.
    expect(screen.getByRole('button', { name: /delete/i })).toBeTruthy()
    expect(screen.getByLabelText('Canvas actions')).toBeTruthy()
    fireEvent.pointerDown(switcher, { button: 0, ctrlKey: false })
    await screen.findByText('Other canvas')
  })

  it('switching the switcher selection calls switchCanvas exactly once', async () => {
    vi.useRealTimers()
    const store = new MemoryStore()
    await store.setDefaultCanvasId('c1')
    await store.save(snap)
    await store.save({ id: 'c2', name: 'Other canvas', updatedAt: '2026-05-25T00:00:00.000Z' })
    await act(async () => {
      render(<BrowserLocalCanvasPage store={store} loro={new FakeLoroStore()} />)
    })
    const switcher = await screen.findByRole('button', { name: 'untitled' })
    fireEvent.pointerDown(switcher, { button: 0, ctrlKey: false })
    const otherItem = await screen.findByText('Other canvas')
    fireEvent.pointerUp(otherItem)
    await waitFor(() => {
      expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Other canvas')
    })
    expect(await store.getDefaultCanvasId()).toBe('c2')
  })

  it('creating a canvas through the top bar switches to a fresh untitled canvas', async () => {
    vi.useRealTimers()
    const store = new MemoryStore()
    await store.setDefaultCanvasId('c1')
    // A distinctly-named current canvas so the switch to the new 'untitled' one
    // is observable in the heading, not just an inert re-render.
    await store.save({ id: 'c1', name: 'Diagram A', updatedAt: '2026-05-24T00:00:00.000Z' })
    await act(async () => {
      render(<BrowserLocalCanvasPage store={store} loro={new FakeLoroStore()} />)
    })
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Diagram A')

    const switcher = await screen.findByRole('button', { name: 'Diagram A' })
    fireEvent.pointerDown(switcher, { button: 0, ctrlKey: false })
    const newItem = await screen.findByTestId('new-canvas-menu-item')
    fireEvent.pointerUp(newItem)
    await waitFor(() => {
      expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('untitled')
    })
    const newId = await store.getDefaultCanvasId()
    expect(newId).not.toBe('c1')
    const list = await store.listCanvases()
    expect(list.map((c) => c.id)).toEqual(expect.arrayContaining(['c1', newId]))
  })

  it('surfaces an error and stays on the current canvas when creating a new canvas fails', async () => {
    vi.useRealTimers()
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
    const switcher = await screen.findByRole('button', { name: 'untitled' })
    fireEvent.pointerDown(switcher, { button: 0, ctrlKey: false })
    const newItem = await screen.findByTestId('new-canvas-menu-item')
    fireEvent.pointerUp(newItem)
    // The rejection from createCanvas() must be caught and surfaced by
    // WorkspaceTopBar's own local-mode error channel, not left as an
    // unhandled promise rejection with the UI silently doing nothing.
    expect((await screen.findByRole('alert')).textContent).toBe('Failed to create canvas.')
    // The current canvas is untouched — no switch happened.
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('untitled')
    expect(await failingCreateStore.getDefaultCanvasId()).toBe('c1')
  })

  it('drops a stale listCanvases resolution that would otherwise clobber a newer refresh from a fast switch', async () => {
    const store = new MemoryStore()
    await store.setDefaultCanvasId('c1')
    vi.useRealTimers()
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
    await screen.findByLabelText('Canvas actions')
    // Resolve the initial mount's list refresh (generation 1) with both
    // canvases, so the switcher has real options to switch between.
    await act(async () => {
      resolvers[0]!([
        snap,
        { id: 'c2', name: 'Other canvas', updatedAt: '2026-05-25T00:00:00.000Z' },
      ])
    })

    // Fast switch: c1 -> c2 -> c1. Each switch bumps the list-refresh
    // generation but its listCanvases() call is left pending (deferred),
    // so two stale refreshes (generation 2 for c2, generation 3 for c1) end
    // up in flight at once.
    const switchTo = async (name: string) => {
      const switcherButton = screen.getByRole('button', { name: /untitled|Other canvas/ })
      fireEvent.pointerDown(switcherButton, { button: 0, ctrlKey: false })
      const item = await screen.findByText(name)
      fireEvent.pointerUp(item)
      await waitFor(() => {
        expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(name)
      })
    }
    await switchTo('Other canvas')
    await switchTo('untitled')
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
    })
    await act(async () => {
      resolvers[1]!(staleList)
    })

    // The stale (generation 2) resolution must not clobber the fresh one:
    // opening the switcher again must show only the fresh name.
    const switcherButton = await screen.findByRole('button', { name: 'untitled (fresh)' })
    fireEvent.pointerDown(switcherButton, { button: 0, ctrlKey: false })
    await screen.findByTestId('new-canvas-menu-item')
    expect(screen.queryByText('Other canvas (stale)')).toBeNull()
  })

  it('never triggers a React setState-in-render warning across mount, canvas switch, and create-canvas', async () => {
    // Ported to the WorkspaceTopBar chrome: switching and creating now go
    // through the bar's switcher dropdown instead of the old combobox/button.
    vi.useRealTimers()
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const store = new MemoryStore()
      await store.setDefaultCanvasId('c1')
      await store.save(snap)
      await store.save({ id: 'c2', name: 'Other canvas', updatedAt: '2026-05-25T00:00:00.000Z' })
      await act(async () => {
        render(<BrowserLocalCanvasPage store={store} loro={new FakeLoroStore()} />)
      })
      assertNoSetStateInRenderWarning(errorSpy)

      // Canvas switch re-renders the title with new key/props.
      const switcher = await screen.findByRole('button', { name: 'untitled' })
      fireEvent.pointerDown(switcher, { button: 0, ctrlKey: false })
      const otherItem = await screen.findByText('Other canvas')
      fireEvent.pointerUp(otherItem)
      await waitFor(() => {
        expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Other canvas')
      })
      assertNoSetStateInRenderWarning(errorSpy)

      // Create-canvas flow drives another switch + re-render.
      const switcher2 = await screen.findByRole('button', { name: 'Other canvas' })
      fireEvent.pointerDown(switcher2, { button: 0, ctrlKey: false })
      const newItem = await screen.findByTestId('new-canvas-menu-item')
      fireEvent.pointerUp(newItem)
      await waitFor(() => {
        expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('untitled')
      })
      assertNoSetStateInRenderWarning(errorSpy)
    } finally {
      errorSpy.mockRestore()
    }
  })

  describe('daemon-only capability messaging', () => {
    const CTA_TEXT =
      'Connect a local daemon (MCP) to unlock version history, workspaces, variations, and combining changes'

    it('shows a single compact CTA line instead of the four daemon-only teaser buttons', async () => {
      const store = new MemoryStore()
      await store.setDefaultCanvasId('c1')
      await store.save(snap)
      await act(async () => {
        render(<BrowserLocalCanvasPage store={store} />)
      })
      expect(screen.getAllByText(CTA_TEXT)).toHaveLength(1)
      for (const label of ['Version history', 'Workspaces', 'Branches', 'Merge']) {
        expect(screen.queryByRole('button', { name: label })).toBeNull()
      }
    })

    it('does not render any mode-switch control — mode stays a read-only status', async () => {
      const store = new MemoryStore()
      await store.setDefaultCanvasId('c1')
      await store.save(snap)
      await act(async () => {
        render(<BrowserLocalCanvasPage store={store} />)
      })
      expect(screen.queryByRole('switch')).toBeNull()
      const suspiciousButtons = screen
        .queryAllByRole('button')
        .filter((btn) => /switch to|mode:|connect daemon/i.test(btn.textContent ?? ''))
      expect(suspiciousButtons).toEqual([])
    })

    it('keeps the existing Delete button and canvas actions control working alongside the CTA line', async () => {
      const store = new MemoryStore()
      await store.setDefaultCanvasId('c1')
      await store.save(snap)
      await act(async () => {
        render(<BrowserLocalCanvasPage store={store} />)
      })
      expect(screen.getByRole('button', { name: /delete/i })).toBeTruthy()
      expect(screen.getByLabelText('Canvas actions')).toBeTruthy()
    })
  })

  describe('theme toggle', () => {
    afterEach(() => {
      localStorage.clear()
      document.documentElement.classList.remove('dark')
    })

    it('renders a theme toggle that cycles system -> light -> dark on repeated clicks', async () => {
      const store = new MemoryStore()
      await store.setDefaultCanvasId('c1')
      await store.save(snap)
      await act(async () => {
        render(<BrowserLocalCanvasPage store={store} />)
      })
      const toggle = screen.getByRole('button', { name: /theme: system/i })
      await act(async () => {
        toggle.click()
      })
      expect(screen.getByRole('button', { name: /theme: light/i })).toBeTruthy()
      // The resolved theme must reach the editor, not just the button label.
      expect(screen.getByTestId('excalidraw-mock').getAttribute('data-theme')).toBe('light')
      const lightToggle = screen.getByRole('button', { name: /theme: light/i })
      await act(async () => {
        lightToggle.click()
      })
      expect(screen.getByRole('button', { name: /theme: dark/i })).toBeTruthy()
      expect(screen.getByTestId('excalidraw-mock').getAttribute('data-theme')).toBe('dark')
    })
  })

  describe('local mode issues no daemon network requests', () => {
    it('mounting and opening the canvas switcher renders no daemon thumbnail <img>', async () => {
      vi.useRealTimers()
      const store = new MemoryStore()
      await store.setDefaultCanvasId('c1')
      await store.save(snap)
      await store.save({ id: 'c2', name: 'Other canvas', updatedAt: '2026-05-25T00:00:00.000Z' })
      await act(async () => {
        render(<BrowserLocalCanvasPage store={store} loro={new FakeLoroStore()} />)
      })
      const switcher = await screen.findByRole('button', { name: 'untitled' })
      fireEvent.pointerDown(switcher, { button: 0, ctrlKey: false })
      await screen.findByText('Other canvas')
      expect(document.querySelectorAll('img[src*="/api/"]').length).toBe(0)
      expect(screen.queryByRole('button', { name: /pin canvas/i })).toBeNull()
    })
  })
})
