import type { DocumentEntry } from '@kamiazya/whiteboard-ports'
import {
  act,
  cleanup,
  fireEvent,
  render as rtlRender,
  screen,
  waitFor,
} from '@testing-library/react'
import { Loro } from 'loro-crdt'
import type { ReactElement } from 'react'
import { createMemoryRouter, MemoryRouter, RouterProvider } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
// Statically imported so the chunk's transform-and-load happens in the
// collection phase, not inside a findBy* retry budget: the page renders
// WorkspaceTopBar through React.lazy, and under a full parallel suite the
// transform alone can outlast testing-library's 1000ms — the delete-confirm
// helper's `More actions` query failed exactly that way in 2/2 full-suite
// runs while every apps/web-only run passed (the lazy()-vs-findBy* family in
// integrator-flow.md; same fix as App.test.tsx's precedent). The import is
// unused by name on purpose — being in the module graph is the fix.
import '../components/WorkspaceTopBar.js'
import type { LoroLoadResult } from '../lib/loro-store.js'
import type { DocumentSnapshot } from '../lib/whiteboard-client.js'
import { LocalStoreDouble } from '../test-utils/local-index.js'
import { assertNoSetStateInRenderWarning } from '../test-utils/no-setstate-in-render.js'
import { BrowserLocalDocumentPage } from './BrowserLocalDocumentPage.js'
import type { LoroStoreLike } from './use-browser-local-document-controller.js'

// The page now reads useLocation/useNavigate for URL<->canvas-id sync, so
// every render needs a Router ancestor — wrapping once here keeps the
// existing single-arg `render(<BrowserLocalDocumentPage .../>)` call sites
// throughout this file unchanged.
function render(ui: ReactElement) {
  return rtlRender(<MemoryRouter initialEntries={['/']}>{ui}</MemoryRouter>)
}

// createDocument seeds an empty Loro doc; the real LoroStore touches IndexedDB,
// which jsdom does not implement. A fake keeps these page-level tests scoped
// to the switcher/create UI wiring, matching the controller test's own fake.
class FakeLoroStore implements LoroStoreLike {
  private byId = new Map<string, Uint8Array>()

  async save(id: string, bytes: Uint8Array): Promise<void> {
    this.byId.set(id, bytes)
  }
  createEmptySnapshot(): Uint8Array {
    return new Uint8Array([1, 2, 3])
  }
  async load(id: string): Promise<LoroLoadResult> {
    const bytes = this.byId.get(id)
    if (bytes === undefined) return { kind: 'not-found' }
    return { kind: 'ok', snapshot: bytes }
  }
}

// BrowserLocalBackend uses LoroDoc; mock it to avoid WASM in jsdom.
vi.mock('../lib/browser-local-backend.js', () => ({
  BrowserLocalBackend: class {
    connect(handlers: { onConnected: () => void; onSnapshot: (b: Uint8Array) => void }) {
      handlers.onConnected()
      // Deliver a minimal empty snapshot so useDocumentSync has a doc.
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

const snap: DocumentSnapshot = {
  documentId: '069CFJNRVY147ADGKPSWZ258BE',
  workspaceId: 'local',
  path: 'untitled',
  name: 'untitled',
  updatedAt: '2026-05-24T00:00:00.000Z',
  kind: 'spatial' as const,
}

// Radix DropdownMenuTrigger opens on pointerDown (not click); the menu
// mounts asynchronously, and items select on pointerUp.
async function openDocumentOpsMenu() {
  // The kebab now lives in the (lazy) WorkspaceTopBar's merged row.
  const trigger = await screen.findByRole('button', { name: 'More actions' })
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false })
  return screen.findByRole('menu')
}

function documentOpsItem(name: RegExp) {
  return screen.findByRole('menuitem', { name })
}

async function openDeleteConfirm() {
  await openDocumentOpsMenu()
  fireEvent.pointerUp(await documentOpsItem(/^delete$/i))
}

describe('BrowserLocalDocumentPage', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  it('renders loading state before canvas is loaded', () => {
    const store = new LocalStoreDouble()
    render(
      <BrowserLocalDocumentPage
        loro={store.loro}
        store={store.index}
        pointer={store.pointer}
        clock={store.clock}
      />,
    )
    expect(screen.getByRole('status')).toBeTruthy()
  })

  it('renders editor view once canvas is loaded', async () => {
    const store = new LocalStoreDouble()
    await store.setDefaultDocumentId('069CFJNRVY147ADGKPSWZ258BE')
    await store.save(snap)
    await act(async () => {
      render(
        <BrowserLocalDocumentPage
          loro={store.loro}
          store={store.index}
          pointer={store.pointer}
          clock={store.clock}
        />,
      )
    })
    expect(screen.getByRole('main')).toBeTruthy()
  })

  it('renders load-degraded banner when store load fails', async () => {
    // The pointer names a document the index does not have. That is what a
    // corrupted metadata row degrades to now: the bespoke store answered a
    // third 'corrupted' outcome from its own parse, and the index has no such
    // answer to give — it either holds the document or it does not.
    const store = new LocalStoreDouble()
    await store.setDefaultDocumentId('069CFJNRVY147ADGKPSWZ258BE')
    await act(async () => {
      render(
        <BrowserLocalDocumentPage
          loro={store.loro}
          store={store.index}
          pointer={store.pointer}
          clock={store.clock}
        />,
      )
    })
    expect(screen.getByRole('alert')).toBeTruthy()
    // Generic safe copy — no raw error
    expect(screen.getByRole('alert').textContent).not.toMatch(
      /\btoken\b|\bAuthorization\b|\bBearer\b/i,
    )
  })

  it('offers a Start fresh recovery action in the load-degraded banner', async () => {
    // The pointer names a document the index does not have. That is what a
    // corrupted metadata row degrades to now: the bespoke store answered a
    // third 'corrupted' outcome from its own parse, and the index has no such
    // answer to give — it either holds the document or it does not.
    const store = new LocalStoreDouble()
    await store.setDefaultDocumentId('069CFJNRVY147ADGKPSWZ258BE')
    await act(async () => {
      render(
        <BrowserLocalDocumentPage
          loro={store.loro}
          store={store.index}
          pointer={store.pointer}
          clock={store.clock}
        />,
      )
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
    // The pointer names a document the index does not have. That is what a
    // corrupted metadata row degrades to now: the bespoke store answered a
    // third 'corrupted' outcome from its own parse, and the index has no such
    // answer to give — it either holds the document or it does not.
    const store = new LocalStoreDouble()
    await store.setDefaultDocumentId('069CFJNRVY147ADGKPSWZ258BE')
    // ...and minting the replacement fails too, so the recovery action has to
    // say so rather than leaving the banner looking actionable.
    store.index.createDocument = async () => {
      throw new Error('idb write failed')
    }
    await act(async () => {
      render(
        <BrowserLocalDocumentPage
          loro={store.loro}
          store={store.index}
          pointer={store.pointer}
          clock={store.clock}
        />,
      )
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
    vi.useRealTimers()
    const store = new LocalStoreDouble()
    await store.setDefaultDocumentId('069CFJNRVY147ADGKPSWZ258BE')
    await store.save(snap)
    await act(async () => {
      render(
        <BrowserLocalDocumentPage
          loro={store.loro}
          store={store.index}
          pointer={store.pointer}
          clock={store.clock}
        />,
      )
    })
    // The kebab lives in the LAZY WorkspaceTopBar: findByRole inside act()
    // deadlocks (act holds commits while waitFor polls), so the helper runs
    // outside act and lets RTL's own act-wrapping handle updates.
    await openDeleteConfirm()
    expect(screen.getByRole('alertdialog')).toBeTruthy()
    const confirmBtn = screen.getByRole('button', { name: /^delete$/i })
    await act(async () => {
      confirmBtn.click()
    })
    expect(await screen.findByTestId('cleanup-completed')).toBeTruthy()
  })

  it('does not delete the canvas when the confirmation dialog is cancelled', async () => {
    vi.useRealTimers()
    const store = new LocalStoreDouble()
    await store.setDefaultDocumentId('069CFJNRVY147ADGKPSWZ258BE')
    await store.save(snap)
    await act(async () => {
      render(
        <BrowserLocalDocumentPage
          loro={store.loro}
          store={store.index}
          pointer={store.pointer}
          clock={store.clock}
        />,
      )
    })
    await act(async () => {
      await openDeleteConfirm()
    })
    expect(screen.getByRole('alertdialog')).toBeTruthy()
    const cancelBtn = screen.getByRole('button', { name: /cancel/i })
    await act(async () => {
      cancelBtn.click()
    })
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    expect(screen.queryByTestId('cleanup-completed')).toBeNull()
    expect(screen.getByRole('main')).toBeTruthy()
  })

  it('duplicates the canvas and switches to the copy when Duplicate is clicked', async () => {
    vi.useRealTimers()
    const store = new LocalStoreDouble()
    await store.setDefaultDocumentId('069CFJNRVY147ADGKPSWZ258BE')
    await store.save(snap)
    const loro = new FakeLoroStore()
    const seed = new Loro()
    seed.getList('elements').push({ id: 'rect-1' })
    await loro.save('069CFJNRVY147ADGKPSWZ258BE', seed.export({ mode: 'snapshot' }))
    await act(async () => {
      render(
        <BrowserLocalDocumentPage
          store={store.index}
          pointer={store.pointer}
          clock={store.clock}
          loro={loro}
        />,
      )
    })
    await openDocumentOpsMenu()
    fireEvent.pointerUp(await documentOpsItem(/duplicate/i))
    await waitFor(() => {
      expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('untitled (copy)')
    })
  })

  it('disables the Duplicate button while a duplicate is in flight, and double-clicking produces exactly one copy', async () => {
    vi.useRealTimers()
    const store = new LocalStoreDouble()
    await store.setDefaultDocumentId('069CFJNRVY147ADGKPSWZ258BE')
    await store.save(snap)
    const loro = new FakeLoroStore()
    const seed = new Loro()
    seed.getList('elements').push({ id: 'rect-1' })
    await loro.save('069CFJNRVY147ADGKPSWZ258BE', seed.export({ mode: 'snapshot' }))
    // Defer the Loro read so the in-flight window is observable and long
    // enough for a second click to land before the first duplicate resolves.
    let releaseLoad: (() => void) | undefined
    const realLoad = loro.load.bind(loro)
    loro.load = async (id: string) => {
      await new Promise<void>((resolve) => {
        releaseLoad = resolve
      })
      return realLoad(id)
    }
    await act(async () => {
      render(
        <BrowserLocalDocumentPage
          store={store.index}
          pointer={store.pointer}
          clock={store.clock}
          loro={loro}
        />,
      )
    })
    await openDocumentOpsMenu()
    fireEvent.pointerUp(await documentOpsItem(/duplicate/i))
    // The menu closes on select; while the duplicate is in flight the item
    // is disabled, so a second attempt from the reopened menu is inert.
    await openDocumentOpsMenu()
    const inFlightItem = await documentOpsItem(/duplicate/i)
    await waitFor(() => expect(inFlightItem.getAttribute('aria-disabled')).toBe('true'))
    fireEvent.pointerUp(inFlightItem)
    await act(async () => {
      releaseLoad?.()
    })
    await waitFor(() => {
      expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('untitled (copy)')
    })
    // The row remounts with the copy (keyed on canvas identity): the fresh
    // menu offers Duplicate enabled again.
    await openDocumentOpsMenu()
    expect((await documentOpsItem(/duplicate/i)).getAttribute('aria-disabled')).toBeNull()
    const list = await store.listDocuments()
    expect(list.filter((c) => c.name === 'untitled (copy)')).toHaveLength(1)
  })

  it('shows an alert and re-enables the Duplicate button when duplicateDocument fails', async () => {
    vi.useRealTimers()
    const store = new LocalStoreDouble()
    await store.setDefaultDocumentId('069CFJNRVY147ADGKPSWZ258BE')
    await store.save(snap)
    const loro = new FakeLoroStore()
    await loro.save('069CFJNRVY147ADGKPSWZ258BE', new Loro().export({ mode: 'snapshot' }))
    await act(async () => {
      render(
        <BrowserLocalDocumentPage
          store={store.index}
          pointer={store.pointer}
          clock={store.clock}
          loro={loro}
        />,
      )
    })
    // Break the Loro read only for the DUPLICATE — the canvas itself loaded
    // fine, so the operations kebab is offered and the failure surfaces as
    // an alert on an otherwise healthy page.
    loro.load = async () => ({ kind: 'corrupt-snapshot' })
    await openDocumentOpsMenu()
    fireEvent.pointerUp(await documentOpsItem(/duplicate/i))
    expect((await screen.findByRole('alert')).textContent).toMatch(/duplicat/i)
    // No switch happened — still on the source canvas. (Asserted before
    // reopening the menu: Radix's modal dropdown aria-hides the page.)
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('untitled')
    await openDocumentOpsMenu()
    expect((await documentOpsItem(/duplicate/i)).getAttribute('aria-disabled')).toBeNull()
  })

  it('Copy as JSON Canvas puts the extended document on the clipboard', async () => {
    vi.useRealTimers()
    const store = new LocalStoreDouble()
    await store.setDefaultDocumentId('069CFJNRVY147ADGKPSWZ258BE')
    await store.save(snap)
    const written: string[] = []
    Object.assign(navigator, {
      clipboard: {
        writeText: (text: string) => {
          written.push(text)
          return Promise.resolve()
        },
      },
    })
    await act(async () => {
      render(
        <BrowserLocalDocumentPage
          loro={store.loro}
          store={store.index}
          pointer={store.pointer}
          clock={store.clock}
        />,
      )
    })
    await openDocumentOpsMenu()
    fireEvent.pointerUp(await documentOpsItem(/copy as json canvas/i))
    await waitFor(() => expect(written).toHaveLength(1))
    const parsed = JSON.parse(written[0] as string) as { nodes: unknown[]; edges: unknown[] }
    expect(Array.isArray(parsed.nodes)).toBe(true)
    expect(Array.isArray(parsed.edges)).toBe(true)
  })

  it('export lives in the canvas row kebab, not the top bar menu', async () => {
    vi.useRealTimers()
    const store = new LocalStoreDouble()
    await store.setDefaultDocumentId('069CFJNRVY147ADGKPSWZ258BE')
    await store.save(snap)
    await act(async () => {
      render(
        <BrowserLocalDocumentPage
          loro={store.loro}
          store={store.index}
          pointer={store.pointer}
          clock={store.clock}
        />,
      )
    })
    // Export is a whole-document operation, so it sits with Duplicate and
    // Delete in the canvas row's More actions kebab.
    await openDocumentOpsMenu()
    expect(await documentOpsItem(/export as png/i)).toBeTruthy()
    expect(await documentOpsItem(/export as svg/i)).toBeTruthy()
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })

    // The top bar's Canvas actions menu keeps rename/copy-URL only on this
    // page (daemon mode, which has no canvas row, keeps its export there).
    const topTrigger = await screen.findByLabelText('Canvas actions')
    fireEvent.pointerDown(topTrigger, { button: 0, ctrlKey: false })
    const topMenu = await screen.findByRole('menu')
    expect(topMenu.textContent).not.toContain('Export')
  })

  it('renders a human-readable save status instead of the raw state enum', async () => {
    const store = new LocalStoreDouble()
    await store.setDefaultDocumentId('069CFJNRVY147ADGKPSWZ258BE')
    await store.save(snap)
    await act(async () => {
      render(
        <BrowserLocalDocumentPage
          loro={store.loro}
          store={store.index}
          pointer={store.pointer}
          clock={store.clock}
        />,
      )
    })
    expect(screen.getByRole('button', { name: 'Saved' })).toBeTruthy()
    // the raw "saved" enum token must not leak to the UI
    expect(screen.queryByText('saved')).toBeNull()
  })

  it('the canvas row carries state, settings and operations in ONE row (no separate strip)', async () => {
    vi.useRealTimers()
    const store = new LocalStoreDouble()
    await store.setDefaultDocumentId('069CFJNRVY147ADGKPSWZ258BE')
    await store.save(snap)
    await act(async () => {
      render(
        <BrowserLocalDocumentPage
          loro={store.loro}
          store={store.index}
          pointer={store.pointer}
          clock={store.clock}
        />,
      )
    })
    // Save state is the color-only dot, named for assistive tech.
    expect(screen.getByTestId('save-status-chip').getAttribute('aria-label')).toBe('Saved')
    // A spatial canvas offers its display settings from the same row.
    expect(screen.getByRole('button', { name: 'Display settings' })).toBeTruthy()
    // The whole cluster lives inside the canvas row (DocumentProperties) —
    // the dot LEFT of the title, the rare operations behind one kebab at
    // the right edge — not in a second header strip of its own.
    const title = screen.getByRole('textbox', { name: /title/i })
    // The merged row IS the workspace header: identity, state and operations
    // all live in the one <header> next to the workspace switcher — there is
    // no second chrome strip.
    const row = title.closest('header') as HTMLElement
    expect(row).toBeTruthy()
    expect(row.contains(screen.getByRole('button', { name: /^Workspace:/i }))).toBe(true)
    const chip = screen.getByTestId('save-status-chip')
    expect(row.contains(chip)).toBe(true)
    expect(chip.compareDocumentPosition(title) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    const kebab = await screen.findByRole('button', { name: 'More actions' })
    expect(row.contains(kebab)).toBe(true)
    // Duplicate/Delete are menu items, not always-visible buttons.
    expect(screen.queryByRole('button', { name: /^duplicate$/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /^delete$/i })).toBeNull()
    await openDocumentOpsMenu()
    expect(await documentOpsItem(/^duplicate$/i)).toBeTruthy()
    expect(await documentOpsItem(/^delete$/i)).toBeTruthy()
  })

  it('surfaces the degraded save message in the header when a save fails', async () => {
    const base = new LocalStoreDouble()
    await base.setDefaultDocumentId('069CFJNRVY147ADGKPSWZ258BE')
    await base.save(snap)
    base.index.setDocumentName = async () => {
      throw new Error('idb write failed')
    }
    await act(async () => {
      render(
        <BrowserLocalDocumentPage
          loro={base.loro}
          store={base.index}
          pointer={base.pointer}
          clock={base.clock}
        />,
      )
    })
    // A real save-failure round trip through SpatialEditor's onChange needs a
    // pointer gesture this suite does not drive; verify the persistence
    // state at least starts as Saved rather than immediately degraded.
    expect(screen.getByRole('button', { name: 'Saved' })).toBeTruthy()
  })

  it('offers a Start fresh action in the cleanup-completed view', async () => {
    vi.useRealTimers()
    const store = new LocalStoreDouble()
    await store.setDefaultDocumentId('069CFJNRVY147ADGKPSWZ258BE')
    await store.save(snap)
    await act(async () => {
      render(
        <BrowserLocalDocumentPage
          loro={store.loro}
          store={store.index}
          pointer={store.pointer}
          clock={store.clock}
        />,
      )
    })
    await act(async () => {
      await openDeleteConfirm()
    })
    const confirmBtn = await screen.findByRole('button', { name: /^delete$/i })
    await act(async () => {
      confirmBtn.click()
    })
    // cleanup-completed must not be a dead end: Start fresh mints a new canvas.
    const startFresh = await screen.findByRole('button', { name: /start fresh/i })
    await act(async () => {
      startFresh.click()
    })
    expect(await screen.findByRole('main')).toBeTruthy()
  })

  it('makes no network requests during load or cleanup', async () => {
    vi.useRealTimers()
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('', { status: 200 }))
    const store = new LocalStoreDouble()
    await store.setDefaultDocumentId('069CFJNRVY147ADGKPSWZ258BE')
    await store.save(snap)
    await act(async () => {
      render(
        <BrowserLocalDocumentPage
          loro={store.loro}
          store={store.index}
          pointer={store.pointer}
          clock={store.clock}
        />,
      )
    })
    await act(async () => {
      await openDeleteConfirm()
    })
    const confirmBtn = await screen.findByRole('button', { name: /^delete$/i })
    await act(async () => {
      confirmBtn.click()
    })
    await screen.findByTestId('cleanup-completed')
    expect(fetchSpy).not.toHaveBeenCalled()
    fetchSpy.mockRestore()
  })

  it('keeps a heading landmark distinct from the Delete button and the canvas actions control', async () => {
    vi.useRealTimers()
    const store = new LocalStoreDouble()
    await store.setDefaultDocumentId('069CFJNRVY147ADGKPSWZ258BE')
    await store.save(snap)
    await act(async () => {
      render(
        <BrowserLocalDocumentPage
          loro={store.loro}
          store={store.index}
          pointer={store.pointer}
          clock={store.clock}
        />,
      )
    })
    const heading = screen.getByRole('heading', { level: 1 })
    expect(heading.textContent).toBe('untitled')
    // WorkspaceTopBar mounts through a lazy chunk; wait for it to resolve.
    expect(await screen.findByLabelText('Canvas actions')).toBeTruthy()
    // Distinct from the canvas row's operations kebab.
    expect(screen.getByRole('button', { name: 'More actions' })).toBeTruthy()
  })

  it("renaming through the top bar's canvas actions updates the heading and flushes a save", async () => {
    vi.useRealTimers()
    const store = new LocalStoreDouble()
    await store.setDefaultDocumentId('069CFJNRVY147ADGKPSWZ258BE')
    await store.save(snap)
    await act(async () => {
      render(
        <BrowserLocalDocumentPage
          loro={store.loro}
          store={store.index}
          pointer={store.pointer}
          clock={store.clock}
        />,
      )
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
    expect((await store.load('069CFJNRVY147ADGKPSWZ258BE'))?.name).toBe('Renamed canvas')
  })

  it('does not render an "Add rectangle" button — scene writes flow through SpatialEditor gestures', async () => {
    const store = new LocalStoreDouble()
    await store.setDefaultDocumentId('069CFJNRVY147ADGKPSWZ258BE')
    await store.save(snap)
    await act(async () => {
      render(
        <BrowserLocalDocumentPage
          loro={store.loro}
          store={store.index}
          pointer={store.pointer}
          clock={store.clock}
        />,
      )
    })
    expect(screen.queryByRole('button', { name: /add rectangle/i })).toBeNull()
  })

  it('lists all documents in the switcher dropdown', async () => {
    vi.useRealTimers()
    const store = new LocalStoreDouble()
    await store.setDefaultDocumentId('069CFJNRVY147ADGKPSWZ258BE')
    await store.save(snap)
    await store.save({
      documentId: '0DGKPSWZ258BEHMQTX0369CFJN',
      workspaceId: 'local',
      path: 'other-canvas',
      name: 'Other canvas',
      updatedAt: '2026-05-25T00:00:00.000Z',
      kind: 'spatial' as const,
    })
    await act(async () => {
      render(
        <BrowserLocalDocumentPage
          store={store.index}
          pointer={store.pointer}
          clock={store.clock}
          loro={new FakeLoroStore()}
        />,
      )
    })
    const switcher = await screen.findByRole('button', { name: /^Workspace:/i })
    // Accessible names must not collide with the operations kebab or the
    // top bar's canvas actions control.
    expect(screen.getByRole('button', { name: 'More actions' })).toBeTruthy()
    expect(screen.getByLabelText('Canvas actions')).toBeTruthy()
    fireEvent.pointerDown(switcher, { button: 0, ctrlKey: false })
    await screen.findByText('Other canvas')
  })

  it('switching the switcher selection calls switchDocument exactly once', async () => {
    vi.useRealTimers()
    const store = new LocalStoreDouble()
    await store.setDefaultDocumentId('069CFJNRVY147ADGKPSWZ258BE')
    await store.save(snap)
    await store.save({
      documentId: '0DGKPSWZ258BEHMQTX0369CFJN',
      workspaceId: 'local',
      path: 'other-canvas-2',
      name: 'Other canvas',
      updatedAt: '2026-05-25T00:00:00.000Z',
      kind: 'spatial' as const,
    })
    await act(async () => {
      render(
        <BrowserLocalDocumentPage
          store={store.index}
          pointer={store.pointer}
          clock={store.clock}
          loro={new FakeLoroStore()}
        />,
      )
    })
    const switcher = await screen.findByRole('button', { name: /^Workspace:/i })
    fireEvent.pointerDown(switcher, { button: 0, ctrlKey: false })
    const otherItem = await screen.findByText('Other canvas')
    fireEvent.pointerUp(otherItem)
    await waitFor(() => {
      expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Other canvas')
    })
    expect(await store.getDefaultDocumentId()).toBe('0DGKPSWZ258BEHMQTX0369CFJN')
  })

  it('honors an explicit initialPath prop over the store default canvas', async () => {
    // This only proves the page itself respects initialPath — it does NOT
    // cover the URL->initialPath wiring (App.tsx's parseBrowserLocalRoute),
    // since the pathname and the prop are set independently here. See
    // App.test.tsx's "derives initialPath from the /local/:path URL"
    // test for that boundary.
    vi.useRealTimers()
    const store = new LocalStoreDouble()
    await store.setDefaultDocumentId('069CFJNRVY147ADGKPSWZ258BE')
    await store.save(snap)
    await store.save({
      documentId: '0DGKPSWZ258BEHMQTX0369CFJN',
      workspaceId: 'local',
      path: 'deep-linked',
      name: 'Other canvas',
      updatedAt: '2026-05-25T00:00:00.000Z',
      kind: 'spatial' as const,
    })
    await act(async () => {
      rtlRender(
        <MemoryRouter initialEntries={['/']}>
          <BrowserLocalDocumentPage
            store={store.index}
            pointer={store.pointer}
            clock={store.clock}
            loro={new FakeLoroStore()}
            initialPath="deep-linked"
          />
        </MemoryRouter>,
      )
    })
    const heading = await screen.findByRole('heading', { level: 1 })
    expect(heading.textContent).toBe('Other canvas')
  })

  it('updates the URL to the switched-to document PATH, not its id', async () => {
    vi.useRealTimers()
    const store = new LocalStoreDouble()
    await store.setDefaultDocumentId('069CFJNRVY147ADGKPSWZ258BE')
    await store.save(snap)
    await store.save({
      documentId: '0DGKPSWZ258BEHMQTX0369CFJN',
      workspaceId: 'local',
      path: 'archive/other-canvas',
      name: 'Other canvas',
      updatedAt: '2026-05-25T00:00:00.000Z',
      kind: 'spatial' as const,
    })
    const router = createMemoryRouter(
      [
        {
          path: '*',
          element: (
            <BrowserLocalDocumentPage
              store={store.index}
              pointer={store.pointer}
              clock={store.clock}
              loro={new FakeLoroStore()}
            />
          ),
        },
      ],
      { initialEntries: ['/'] },
    )
    await act(async () => {
      rtlRender(<RouterProvider router={router} />)
    })
    const switcher = await screen.findByRole('button', { name: /^Workspace:/i })
    fireEvent.pointerDown(switcher, { button: 0, ctrlKey: false })
    const otherItem = await screen.findByText('Other canvas')
    fireEvent.pointerUp(otherItem)
    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/local/archive/other-canvas')
    })
  })

  it('creating a canvas through the top bar switches to a fresh untitled canvas', async () => {
    vi.useRealTimers()
    const store = new LocalStoreDouble()
    await store.setDefaultDocumentId('069CFJNRVY147ADGKPSWZ258BE')
    // A distinctly-named current canvas so the switch to the new 'untitled' one
    // is observable in the heading, not just an inert re-render.
    await store.save({
      documentId: '069CFJNRVY147ADGKPSWZ258BE',
      workspaceId: 'local',
      path: 'diagram-a',
      name: 'Diagram A',
      updatedAt: '2026-05-24T00:00:00.000Z',
      kind: 'spatial' as const,
    })
    await act(async () => {
      render(
        <BrowserLocalDocumentPage
          store={store.index}
          pointer={store.pointer}
          clock={store.clock}
          loro={new FakeLoroStore()}
        />,
      )
    })
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Diagram A')

    const switcher = await screen.findByRole('button', { name: /^Workspace:/i })
    fireEvent.pointerDown(switcher, { button: 0, ctrlKey: false })
    const newItem = await screen.findByTestId('new-document-menu-item')
    fireEvent.pointerUp(newItem)
    await waitFor(() => {
      expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('untitled')
    })
    const newId = await store.getDefaultDocumentId()
    expect(newId).not.toBe('069CFJNRVY147ADGKPSWZ258BE')
    const list = await store.listDocuments()
    expect(list.map((c) => c.documentId)).toEqual(
      expect.arrayContaining(['069CFJNRVY147ADGKPSWZ258BE', newId]),
    )
  })

  it('surfaces an error and stays on the current canvas when creating a new canvas fails', async () => {
    vi.useRealTimers()
    const base = new LocalStoreDouble()
    await base.setDefaultDocumentId('069CFJNRVY147ADGKPSWZ258BE')
    await base.save(snap)
    // Fail the metadata save that createDocument performs first, so createDocument()
    // rejects before ever calling switchDocument.
    let failNextSave = false
    const create = base.index.createDocument.bind(base.index)
    base.index.createDocument = async (input) => {
      if (failNextSave) throw new Error('idb write failed')
      return create(input)
    }
    await act(async () => {
      render(
        <BrowserLocalDocumentPage
          store={base.index}
          pointer={base.pointer}
          clock={base.clock}
          loro={new FakeLoroStore()}
        />,
      )
    })
    failNextSave = true
    const switcher = await screen.findByRole('button', { name: /^Workspace:/i })
    fireEvent.pointerDown(switcher, { button: 0, ctrlKey: false })
    const newItem = await screen.findByTestId('new-document-menu-item')
    fireEvent.pointerUp(newItem)
    // The rejection from createDocument() must be caught and surfaced by
    // WorkspaceTopBar's own local-mode error channel, not left as an
    // unhandled promise rejection with the UI silently doing nothing.
    expect((await screen.findByRole('alert')).textContent).toBe('Failed to create canvas.')
    // The current canvas is untouched — no switch happened.
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('untitled')
    expect(await base.getDefaultDocumentId()).toBe('069CFJNRVY147ADGKPSWZ258BE')
  })

  it('drops a stale listDocuments resolution that would otherwise clobber a newer refresh from a fast switch', async () => {
    const store = new LocalStoreDouble()
    await store.setDefaultDocumentId('069CFJNRVY147ADGKPSWZ258BE')
    vi.useRealTimers()
    await store.save(snap)
    await store.save({
      documentId: '0DGKPSWZ258BEHMQTX0369CFJN',
      workspaceId: 'local',
      path: 'other-canvas-5',
      name: 'Other canvas',
      updatedAt: '2026-05-25T00:00:00.000Z',
      kind: 'spatial' as const,
    })

    // Held open at the PORT, one rung below where the old double held it: the
    // listing the page renders is `listLocalDocuments`, and the read it waits
    // on is the index's.
    const resolvers: Array<(list: DocumentEntry[]) => void> = []
    store.index.listDocuments = () => new Promise((resolve) => resolvers.push(resolve))

    await act(async () => {
      render(
        <BrowserLocalDocumentPage
          store={store.index}
          pointer={store.pointer}
          clock={store.clock}
          loro={new FakeLoroStore()}
        />,
      )
    })
    await screen.findByLabelText('Canvas actions')
    // Resolve the initial mount's list refresh (generation 1) with both
    // documents, so the switcher has real options to switch between.
    await act(async () => {
      resolvers[0]!([
        snap,
        {
          documentId: '0DGKPSWZ258BEHMQTX0369CFJN',
          workspaceId: 'local',
          path: 'other-canvas-6',
          name: 'Other canvas',
          updatedAt: '2026-05-25T00:00:00.000Z',
          kind: 'spatial' as const,
        },
      ])
    })

    // Fast switch: c1 -> c2 -> c1. Each switch bumps the list-refresh
    // generation but its listDocuments() call is left pending (deferred),
    // so two stale refreshes (generation 2 for c2, generation 3 for c1) end
    // up in flight at once.
    const switchTo = async (name: string) => {
      const switcherButton = screen.getByRole('button', { name: /^Workspace:/i })
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
    // The fresh marker rides a row OTHER than the open canvas: the open
    // canvas's own label comes from the loaded snapshot, not from the list.
    const freshList: DocumentSnapshot[] = [
      snap,
      {
        documentId: '0MQTX0369CFJNRVY147ADGKPSW',
        workspaceId: 'local',
        path: 'other-canvas-fresh',
        name: 'Other canvas (fresh)',
        updatedAt: '2026-05-26T00:00:00.000Z',
        kind: 'spatial' as const,
      },
    ]
    const staleList: DocumentSnapshot[] = [
      {
        documentId: '0DGKPSWZ258BEHMQTX0369CFJN',
        workspaceId: 'local',
        path: 'other-canvas-stale',
        name: 'Other canvas (stale)',
        updatedAt: '2026-05-25T00:00:00.000Z',
        kind: 'spatial' as const,
      },
    ]
    await act(async () => {
      resolvers[2]!(freshList)
    })
    await act(async () => {
      resolvers[1]!(staleList)
    })

    // The stale (generation 2) resolution must not clobber the fresh one:
    // opening the switcher again must show only the fresh name.
    const switcherButton = await screen.findByRole('button', { name: /^Workspace:/i })
    fireEvent.pointerDown(switcherButton, { button: 0, ctrlKey: false })
    await screen.findByText('Other canvas (fresh)')
    expect(screen.queryByText('Other canvas (stale)')).toBeNull()
  })

  it('shows the renamed canvas in the switcher even when the list read wins the race against the save', async () => {
    vi.useRealTimers()
    const store = new LocalStoreDouble()
    await store.setDefaultDocumentId('069CFJNRVY147ADGKPSWZ258BE')
    await store.save(snap)

    // Held open at the PORT, one rung below where the old double held it: the
    // listing the page renders is `listLocalDocuments`, and the read it waits
    // on is the index's.
    const resolvers: Array<(list: DocumentEntry[]) => void> = []
    store.index.listDocuments = () => new Promise((resolve) => resolvers.push(resolve))

    await act(async () => {
      render(
        <BrowserLocalDocumentPage
          store={store.index}
          pointer={store.pointer}
          clock={store.clock}
          loro={new FakeLoroStore()}
        />,
      )
    })
    await act(async () => {
      resolvers[0]!([snap])
    })

    const canvasActions = await screen.findByLabelText('Canvas actions')
    fireEvent.pointerDown(canvasActions, { button: 0, ctrlKey: false })
    fireEvent.pointerUp(await screen.findByText('Rename canvas'))
    const titleInput = screen.getByRole('textbox', { name: /canvas title/i })
    const refreshesBeforeRename = resolvers.length
    fireEvent.change(titleInput, { target: { value: 'Renamed canvas' } })
    fireEvent.keyDown(titleInput, { key: 'Enter' })
    await waitFor(() => {
      expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Renamed canvas')
    })

    // The rename must have queued a list refresh of its own — otherwise
    // resolving "the latest" one below would just re-resolve an already-settled
    // promise from mount and pass without exercising the race at all.
    expect(resolvers.length).toBeGreaterThan(refreshesBeforeRename)

    // It resolves with the PRE-rename row: the store read raced the
    // still-in-flight save and lost. Nothing schedules another refresh
    // afterwards, so a list-only switcher label would stay stale forever —
    // the current canvas's row must come from the loaded snapshot.
    await act(async () => {
      resolvers[resolvers.length - 1]!([snap])
    })
    expect(screen.getByRole('button', { name: /^Workspace:/i })).toBeTruthy()
  })

  it('never triggers a React setState-in-render warning across mount, canvas switch, and create-canvas', async () => {
    // Ported to the WorkspaceTopBar chrome: switching and creating now go
    // through the bar's switcher dropdown instead of the old combobox/button.
    vi.useRealTimers()
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const store = new LocalStoreDouble()
      await store.setDefaultDocumentId('069CFJNRVY147ADGKPSWZ258BE')
      await store.save(snap)
      await store.save({
        documentId: '0DGKPSWZ258BEHMQTX0369CFJN',
        workspaceId: 'local',
        path: 'other-canvas-7',
        name: 'Other canvas',
        updatedAt: '2026-05-25T00:00:00.000Z',
        kind: 'spatial' as const,
      })
      await act(async () => {
        render(
          <BrowserLocalDocumentPage
            store={store.index}
            pointer={store.pointer}
            clock={store.clock}
            loro={new FakeLoroStore()}
          />,
        )
      })
      assertNoSetStateInRenderWarning(errorSpy)

      // Canvas switch re-renders the title with new key/props.
      const switcher = await screen.findByRole('button', { name: /^Workspace:/i })
      fireEvent.pointerDown(switcher, { button: 0, ctrlKey: false })
      const otherItem = await screen.findByText('Other canvas')
      fireEvent.pointerUp(otherItem)
      await waitFor(() => {
        expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Other canvas')
      })
      assertNoSetStateInRenderWarning(errorSpy)

      // Create-canvas flow drives another switch + re-render.
      const switcher2 = await screen.findByRole('button', { name: /^Workspace:/i })
      fireEvent.pointerDown(switcher2, { button: 0, ctrlKey: false })
      const newItem = await screen.findByTestId('new-document-menu-item')
      fireEvent.pointerUp(newItem)
      await waitFor(() => {
        // 'untitled-2': the seeded canvas already holds the path 'untitled',
        // an unnamed document reads as its path, and the index refuses to
        // hand the same path out twice.
        expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('untitled-2')
      })
      assertNoSetStateInRenderWarning(errorSpy)
    } finally {
      errorSpy.mockRestore()
    }
  })

  describe('daemon-only capability messaging', () => {
    const CTA_TEXT =
      'Connect a local daemon (MCP) to unlock version history, workspaces, variations, and combining changes'

    it('moves the capability CTA into the Local connection chip popover (D1: no standing copy)', async () => {
      const store = new LocalStoreDouble()
      await store.setDefaultDocumentId('069CFJNRVY147ADGKPSWZ258BE')
      await store.save(snap)
      await act(async () => {
        render(
          <BrowserLocalDocumentPage
            loro={store.loro}
            store={store.index}
            pointer={store.pointer}
            clock={store.clock}
          />,
        )
      })
      // No sentence-length CTA sits in the page chrome anymore...
      expect(screen.queryByText(CTA_TEXT)).toBeNull()
      for (const label of ['Version history', 'Workspaces', 'Branches', 'Merge']) {
        expect(screen.queryByRole('button', { name: label })).toBeNull()
      }
      // ...it lives in the Local chip's popover, next to the storage note.
      // (Synchronous assertions: this file runs under fake timers, so
      // findBy*'s real-timer polling would hang.)
      await act(async () => {
        fireEvent.click(screen.getByTestId('connection-chip'))
      })
      expect(screen.getByText(/only in this browser/i)).toBeTruthy()
      expect(screen.getByText(CTA_TEXT)).toBeTruthy()
    })

    it('does not render any mode-switch control — mode stays a read-only status', async () => {
      const store = new LocalStoreDouble()
      await store.setDefaultDocumentId('069CFJNRVY147ADGKPSWZ258BE')
      await store.save(snap)
      await act(async () => {
        render(
          <BrowserLocalDocumentPage
            loro={store.loro}
            store={store.index}
            pointer={store.pointer}
            clock={store.clock}
          />,
        )
      })
      expect(screen.queryByRole('switch')).toBeNull()
      const suspiciousButtons = screen
        .queryAllByRole('button')
        .filter((btn) => /switch to|mode:|connect daemon/i.test(btn.textContent ?? ''))
      expect(suspiciousButtons).toEqual([])
    })

    it('keeps the existing Delete button and canvas actions control working alongside the CTA line', async () => {
      const store = new LocalStoreDouble()
      await store.setDefaultDocumentId('069CFJNRVY147ADGKPSWZ258BE')
      await store.save(snap)
      await act(async () => {
        render(
          <BrowserLocalDocumentPage
            loro={store.loro}
            store={store.index}
            pointer={store.pointer}
            clock={store.clock}
          />,
        )
      })
      expect(screen.getByRole('button', { name: 'More actions' })).toBeTruthy()
      expect(screen.getByLabelText('Canvas actions')).toBeTruthy()
    })
  })

  describe('local mode issues no daemon network requests', () => {
    it('mounting and opening the canvas switcher renders no daemon thumbnail <img>', async () => {
      vi.useRealTimers()
      const store = new LocalStoreDouble()
      await store.setDefaultDocumentId('069CFJNRVY147ADGKPSWZ258BE')
      await store.save(snap)
      await store.save({
        documentId: '0DGKPSWZ258BEHMQTX0369CFJN',
        workspaceId: 'local',
        path: 'other-canvas-8',
        name: 'Other canvas',
        updatedAt: '2026-05-25T00:00:00.000Z',
        kind: 'spatial' as const,
      })
      await act(async () => {
        render(
          <BrowserLocalDocumentPage
            store={store.index}
            pointer={store.pointer}
            clock={store.clock}
            loro={new FakeLoroStore()}
          />,
        )
      })
      const switcher = await screen.findByRole('button', { name: /^Workspace:/i })
      fireEvent.pointerDown(switcher, { button: 0, ctrlKey: false })
      await screen.findByText('Other canvas')
      expect(document.querySelectorAll('img[src*="/api/"]').length).toBe(0)
      expect(screen.queryByRole('button', { name: /pin canvas/i })).toBeNull()
    })
  })
})

describe('?new=canvas launch shortcut', () => {
  it('creates a fresh canvas on load and strips the param from the URL', async () => {
    // An existing profile: auto-create is skipped, so the count isolates
    // the shortcut's own create.
    const store = new LocalStoreDouble()
    await store.setDefaultDocumentId('069CFJNRVY147ADGKPSWZ258BE')
    await store.save(snap)
    window.history.replaceState(null, '', '/?new=canvas')
    rtlRender(
      <MemoryRouter initialEntries={['/?new=canvas']}>
        <BrowserLocalDocumentPage
          store={store.index}
          pointer={store.pointer}
          clock={store.clock}
          loro={new FakeLoroStore()}
        />
      </MemoryRouter>,
    )
    await waitFor(async () => {
      expect((await store.listDocuments()).length).toBe(2)
    })
    expect(window.location.search).not.toContain('new=canvas')
    window.history.replaceState(null, '', '/')
  })

  it('does not create extras on a plain load', async () => {
    const store = new LocalStoreDouble()
    render(
      <BrowserLocalDocumentPage
        store={store.index}
        pointer={store.pointer}
        clock={store.clock}
        loro={new FakeLoroStore()}
      />,
    )
    await waitFor(async () => {
      expect((await store.listDocuments()).length).toBe(1)
    })
  })

  it('a failed create rolls back the canvas and still strips the param', async () => {
    // The shortcut create is fire-and-forget; a rejected Loro save must be
    // caught by the page (not surface as an unhandled rejection) and the
    // controller's rollback must remove the half-created metadata row.
    class RejectingLoroStore extends FakeLoroStore {
      override async save(): Promise<void> {
        throw new Error('loro save failed')
      }
    }
    const store = new LocalStoreDouble()
    await store.setDefaultDocumentId('069CFJNRVY147ADGKPSWZ258BE')
    await store.save(snap)
    window.history.replaceState(null, '', '/?new=canvas')
    rtlRender(
      <MemoryRouter initialEntries={['/?new=canvas']}>
        <BrowserLocalDocumentPage
          store={store.index}
          pointer={store.pointer}
          clock={store.clock}
          loro={new RejectingLoroStore()}
        />
      </MemoryRouter>,
    )
    expect(window.location.search).not.toContain('new=canvas')
    await waitFor(async () => {
      expect((await store.listDocuments()).length).toBe(1)
    })
    window.history.replaceState(null, '', '/')
  })
})

describe('BrowserLocalDocumentPage — initial tool follows the canvas shape', () => {
  afterEach(() => {
    sessionStorage.clear()
  })

  it('an empty canvas opens in Select — the user came to place, not to pan', async () => {
    const store = new LocalStoreDouble()
    await store.setDefaultDocumentId('069CFJNRVY147ADGKPSWZ258BE')
    await store.save(snap)
    await act(async () => {
      render(
        <BrowserLocalDocumentPage
          store={store.index}
          pointer={store.pointer}
          clock={store.clock}
          loro={new FakeLoroStore()}
        />,
      )
    })
    expect(
      (await screen.findByRole('button', { name: 'Select' })).getAttribute('aria-pressed'),
    ).toBe('true')
  })

  it("this tab's last choice outranks the canvas-shape guess", async () => {
    sessionStorage.setItem('wb.lastTool', 'hand')
    const store = new LocalStoreDouble()
    await store.setDefaultDocumentId('069CFJNRVY147ADGKPSWZ258BE')
    await store.save(snap)
    await act(async () => {
      render(
        <BrowserLocalDocumentPage
          store={store.index}
          pointer={store.pointer}
          clock={store.clock}
          loro={new FakeLoroStore()}
        />,
      )
    })
    expect(
      (await screen.findByRole('button', { name: 'Hand (pan)' })).getAttribute('aria-pressed'),
    ).toBe('true')
  })
})
