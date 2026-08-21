/**
 * Browser Back/Forward must round-trip through the loaded canvas, not just
 * the address bar: create+switch to a second canvas, go Back to the first
 * (proving the URL->switchDocument direction fires), then Forward to the
 * second again.
 *
 * SpatialEditor is mocked (see BrowserLocalDocumentPage.reload-elements.browser.test.tsx's
 * doc comment for why) so each canvas's edit is driven deterministically via
 * onChange — this suite's subject is router<->canvas-id sync, not gesture
 * input.
 */

// jsdom + fake-indexeddb: this suite drives page wiring over IndexedDB
// persistence with the spatial editor mocked — no browser layout or input
// fidelity at stake. The real-IDB contract stays pinned by the four
// browser-mode keeper suites (see loro-store.browser.test.tsx).
import 'fake-indexeddb/auto'
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import {
  act,
  cleanup,
  configure,
  fireEvent,
  render as rtlRender,
  screen,
  waitFor,
} from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EditorCommand } from '../components/spatial-editor/commands.js'
import { IdbDocumentIndex } from '../lib/idb-document-index.js'
import { IdbDefaultDocumentPointer, listLocalDocuments } from '../lib/local-document-summary.js'
import {
  clearWhiteboardDb,
  persistedNodeIds,
  setTextCommand,
  textNodeCanvas,
} from '../test-utils/browser-local-document.js'
import '../index.css'
import { claimIsolatedWhiteboardDb } from '../test-utils/isolated-whiteboard-db.js'

claimIsolatedWhiteboardDb('browserlocaldocumentpage-history-nav')

type OnChange = (next: SpatialCanvas, command: EditorCommand) => void

let latestOnChange: OnChange | null = null
// The canvas the editor is CURRENTLY mounted with. Asserting the router path
// and the store's default-canvas pointer only proves the navigation happened;
// both would still agree while the editor kept rendering the canvas it had
// before the switch.
let latestCanvas: SpatialCanvas | null = null

vi.mock('../components/spatial-editor/index.js', () => ({
  SpatialEditor: (props: { canvas: SpatialCanvas; onChange?: OnChange }) => {
    latestOnChange = props.onChange ?? null
    latestCanvas = props.canvas
    return null
  },
}))

function mountedNodeIds(): string[] {
  return (latestCanvas?.nodes ?? []).map((node) => node.id)
}

const { BrowserLocalDocumentPage } = await import('./BrowserLocalDocumentPage.js')

// The address bar names a document by PATH; the store's default pointer names
// it by id. Every URL assertion below goes through this so the two are never
// silently conflated.
async function pathOf(store: IdbDocumentIndex, documentId: string): Promise<string> {
  const found = (await listLocalDocuments(store)).find((row) => row.documentId === documentId)
  if (found === undefined) throw new Error(`no document ${documentId}`)
  return found.path
}

// These suites came from browser mode, where the per-test budget is 60s, and
// kept their 10s waits when they moved to jsdom — whose default is 5s, so a
// wait that actually has to wait can never finish inside its own test. Not
// theoretical: content persistence now goes through the `DocumentStore` port,
// which costs two to three IndexedDB round trips where it used to cost one,
// and `fake-indexeddb` is slower per round trip than the real thing.
vi.setConfig({ testTimeout: 30_000 })
// One budget for every wait in the file, rather than a number per call site.
// These waits came from browser mode with 60s per test; none of them is a
// deliberate "this must be fast" assertion, and reading a document back is
// two IndexedDB round trips behind the `DocumentStore` port plus a Loro
// import — which under fake-indexeddb on a loaded runner does not fit 5s.
configure({ asyncUtilTimeout: 15_000 })

describe('BrowserLocalDocumentPage browser Back/Forward (browser — real IndexedDB)', () => {
  beforeEach(async () => {
    await clearWhiteboardDb()
    latestOnChange = null
  })

  afterEach(() => {
    cleanup()
  })

  it('Back returns to the first canvas and Forward returns to the second', async () => {
    const store = new IdbDocumentIndex()
    const router = createMemoryRouter(
      [
        {
          path: '*',
          element: <BrowserLocalDocumentPage store={store} />,
        },
      ],
      { initialEntries: ['/'] },
    )
    rtlRender(
      <div style={{ height: '100vh' }}>
        <RouterProvider router={router} />
      </div>,
    )

    await waitFor(() => expect(screen.getByTestId('spatial-editor-container')).toBeTruthy())
    await waitFor(() => expect(latestOnChange).not.toBeNull())

    const idA = await waitFor(async () => {
      const id = await new IdbDefaultDocumentPointer().get()
      expect(id).not.toBeNull()
      return id as string
    })
    const pathA = await pathOf(store, idA)

    const nodeA = textNodeCanvas('history-nav-node-a', 0, 0)
    await waitFor(
      async () => {
        act(() => {
          latestOnChange!(nodeA, setTextCommand('history-nav-node-a'))
        })
        expect(await persistedNodeIds(idA)).toContain('history-nav-node-a')
      },
      { interval: 600 },
    )

    // Create canvas B via the switcher's New-canvas control.
    const switcherA = await screen.findByRole('button', { name: /^Workspace:/i })
    fireEvent.pointerDown(switcherA, { button: 0, ctrlKey: false })
    const newItem = await screen.findByTestId('new-document-menu-item')
    await act(async () => {
      fireEvent.pointerUp(newItem)
    })

    const idB = await waitFor(async () => {
      const id = await new IdbDefaultDocumentPointer().get()
      expect(id).not.toBe(idA)
      return id as string
    })
    const pathB = await pathOf(store, idB)
    expect(pathB).not.toBe(pathA)

    await waitFor(() => expect(router.state.location.pathname).toBe(`/local/${pathB}`))

    const nodeB = textNodeCanvas('history-nav-node-b', 20, 20)
    await waitFor(
      async () => {
        act(() => {
          latestOnChange!(nodeB, setTextCommand('history-nav-node-b'))
        })
        expect(await persistedNodeIds(idB)).toContain('history-nav-node-b')
      },
      { interval: 600 },
    )

    // Back: real browser Back/Forward drives router history the same way
    // router.navigate(-1) does — a POP navigation the component never
    // triggers itself.
    await act(async () => {
      await router.navigate(-1)
    })

    await waitFor(() => expect(router.state.location.pathname).toBe(`/local/${pathA}`))
    await waitFor(async () => {
      expect(await new IdbDefaultDocumentPointer().get()).toBe(idA)
    })
    await waitFor(() => expect(screen.getByRole('heading', { level: 1 })).toBeTruthy())
    // The editor must actually be showing canvas A now — the assertions above
    // only establish that the navigation and the store agree about which
    // canvas is current.
    await waitFor(() => expect(mountedNodeIds()).toContain('history-nav-node-a'))
    expect(mountedNodeIds()).not.toContain('history-nav-node-b')

    // Forward: back to B.
    await act(async () => {
      await router.navigate(1)
    })

    await waitFor(() => expect(router.state.location.pathname).toBe(`/local/${pathB}`))
    await waitFor(async () => {
      expect(await new IdbDefaultDocumentPointer().get()).toBe(idB)
    })
    await waitFor(() => expect(mountedNodeIds()).toContain('history-nav-node-b'))
    expect(mountedNodeIds()).not.toContain('history-nav-node-a')
  })
})
