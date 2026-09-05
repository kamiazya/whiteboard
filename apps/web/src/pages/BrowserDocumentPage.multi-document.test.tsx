/**
 * S-C2 multi-canvas UI (real IndexedDB): edit canvas A, switch to a fresh
 * empty canvas B, switch back to A, and confirm A's node is restored. Proves
 * the store+controller API is driven end to end by a document CHANGE,
 * including the useDocumentSync reconnect-on-backend-identity-change path.
 *
 * The editor creates and switches nothing itself any more — both are the
 * document browser's job, and the browser drives the editor by navigating to
 * `/w/default/d/:path`. So B is created the way that page creates it
 * (`createSeededDocument`) and the switch is a route change, which is the
 * real mechanism rather than a stand-in for one.
 *
 * SpatialEditor is mocked (see BrowserDocumentPage.reload-elements.browser.test.tsx's
 * doc comment for why) so edits are driven deterministically via onChange —
 * this suite's subject is the backend/IndexedDB sync layer, not gesture input.
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
  render as rtlRender,
  screen,
  waitFor,
} from '@testing-library/react'
import type { ReactElement } from 'react'
import { useEffect } from 'react'
import { MemoryRouter, useNavigate } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { documentPath } from '../lib/app-routes.js'
import { BROWSER_DEFAULT_SEGMENT } from '../lib/browser-idb.js'
import { IdbDocumentIndex } from '../lib/idb-document-index.js'
import {
  IdbDefaultDocumentPointer,
  idbContentClock,
  listLocalDocuments,
} from '../lib/local-document-summary.js'
import { LoroStore } from '../lib/loro-store.js'
import type { EditorCommand } from '../lib/spatial/commands.js'
import {
  clearWhiteboardDb,
  loroDocumentsKeys,
  persistedNodeIds,
  setTextCommand,
  textNodeCanvas,
} from '../test-utils/browser-document.js'
import '../index.css'
import { claimIsolatedWhiteboardDb } from '../test-utils/isolated-whiteboard-db.js'
// The lazy WorkspaceTopBar chunk, transformed in the collection phase so a
// findBy* on its controls never pays the load (integrator-flow.md's
// lazy()-vs-findBy* family; see BrowserDocumentPage.test.tsx).
import '../components/WorkspaceTopBar.js'

claimIsolatedWhiteboardDb('browserdocumentpage-multi-document')

// The page reads/writes the canvas id through the router, so it needs a router
// in scope exactly as it has one in main.tsx.
// Stands in for the document browser: the only thing it does to this page is
// change the URL, which is exactly what picking a document there does.
let navigateTo: ((to: string) => void) | null = null
function NavigationProbe() {
  const navigate = useNavigate()
  useEffect(() => {
    navigateTo = navigate
    return () => {
      navigateTo = null
    }
  }, [navigate])
  return null
}

function render(ui: ReactElement) {
  return rtlRender(
    // Pages fill their allotted height (h-full) — the app shell owns the
    // viewport in production, so tests supply the equivalent sized parent.
    <div style={{ height: '100vh' }}>
      <MemoryRouter initialEntries={['/']}>
        <NavigationProbe />
        {ui}
      </MemoryRouter>
    </div>,
  )
}

/**
 * Seeds the two documents this suite switches between, exactly as the
 * document browser's New does, and points the default at the first — so the
 * page opens A and already knows B is there.
 *
 * Seeded BEFORE the page mounts on purpose: an in-place switch resolves the
 * URL's path against the documents the controller has listed, which is also
 * the only way it happens in the product (browser Back/Forward, or following
 * a [[reference]]). A document created behind the controller's back is not
 * in that list and the navigation would be a no-op.
 */
async function seedTwoDocuments(store: IdbDocumentIndex): Promise<[string, string]> {
  const { createSeededDocument } = await import('./use-browser-document-controller.js')
  const loro = new LoroStore()
  const clock = idbContentClock()
  const a = await createSeededDocument(store, loro, clock)
  const b = await createSeededDocument(store, loro, clock)
  await new IdbDefaultDocumentPointer().set(a.documentId)
  return [a.path, b.path]
}

async function openDocument(path: string): Promise<void> {
  await act(async () => {
    navigateTo?.(documentPath(BROWSER_DEFAULT_SEGMENT, path))
  })
}

type OnChange = (next: SpatialCanvas, command: EditorCommand) => void

let latestOnChange: OnChange | null = null
let latestMountedCanvases: SpatialCanvas[] = []

vi.mock('../components/spatial-editor/index.js', () => ({
  SpatialEditor: (props: { canvas: SpatialCanvas; onChange?: OnChange }) => {
    latestOnChange = props.onChange ?? null
    latestMountedCanvases.push(props.canvas)
    return null
  },
}))

const { BrowserDocumentPage } = await import('./BrowserDocumentPage.js')

// The switcher addresses a document by PATH; the store's default pointer and
// every persistence helper here address it by id. This is the one conversion.
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

describe('BrowserDocumentPage multi-canvas UI (real IndexedDB)', () => {
  beforeEach(async () => {
    await clearWhiteboardDb()
    latestOnChange = null
    latestMountedCanvases = []
  })

  afterEach(() => {
    cleanup()
  })

  it('edits A, switching to empty B and back to A restores the edited node', async () => {
    const store = new IdbDocumentIndex()
    const [pathA, pathB] = await seedTwoDocuments(store)
    render(<BrowserDocumentPage store={store} />)
    await waitFor(() => expect(screen.getByTestId('spatial-editor-container')).toBeTruthy())
    await waitFor(() => expect(latestOnChange).not.toBeNull())

    const idA = await waitFor(async () => {
      const heading = screen.getByRole('heading', { level: 1 })
      expect(heading).toBeTruthy()
      const id = await new IdbDefaultDocumentPointer().get()
      expect(id).not.toBeNull()
      return id as string
    })

    const nodeA = textNodeCanvas('multi-canvas-node-a', 10, 10)

    // Re-fire until the EDIT lands, not until a record exists: every create
    // path seeds one, so a poll on "the key is there" is satisfied before any
    // edit does and stops retrying. See reload-elements for why the re-fire is
    // needed at all — the backend connects asynchronously with no sync signal.
    await waitFor(
      async () => {
        act(() => {
          latestOnChange!(nodeA, setTextCommand('multi-canvas-node-a'))
        })
        expect(await persistedNodeIds(idA)).toContain('multi-canvas-node-a')
      },
      { interval: 600 },
    )

    // Open B by navigating, which is all the document browser does to this
    // page.
    await openDocument(pathB)

    const idB = await waitFor(async () => {
      const id = await new IdbDefaultDocumentPointer().get()
      expect(id).not.toBe(idA)
      return id as string
    })

    // B is a fresh canvas: its persisted doc must never contain A's node —
    // asserted straight from IndexedDB so the check is independent of the
    // mock SpatialEditor's render timing.
    expect(await persistedNodeIds(idB)).not.toContain('multi-canvas-node-a')

    // No stray placeholder row from the backend re-key.
    expect(await loroDocumentsKeys()).not.toContain('__placeholder__')

    // Switch back to A. Both A and B default to the "untitled" display NAME,
    // so their paths are what separate them — which is what the URL carries.
    expect(await pathOf(store, idA)).toBe(pathA)
    // `latestMountedCanvases` accumulates every mount, including the one from
    // when A was originally open. Only mounts recorded from here on can show
    // that switching BACK re-hydrated A — searching the whole history would
    // pass even if the switch mounted nothing at all.
    const mountsBeforeSwitchBack = latestMountedCanvases.length
    await openDocument(pathA)

    await waitFor(() => {
      const restoredIds = latestMountedCanvases
        .slice(mountsBeforeSwitchBack)
        .flatMap((canvas) => canvas.nodes.map((n) => n.id))
      expect(restoredIds).toContain('multi-canvas-node-a')
    })

    expect(await loroDocumentsKeys()).not.toContain('__placeholder__')
  })

  it('persists an edit made inside the 300ms debounce before switching canvas', async () => {
    const store = new IdbDocumentIndex()
    const [, pathB] = await seedTwoDocuments(store)
    render(<BrowserDocumentPage store={store} />)
    await waitFor(() => expect(screen.getByTestId('spatial-editor-container')).toBeTruthy())
    await waitFor(() => expect(latestOnChange).not.toBeNull())

    const idA = await waitFor(async () => {
      const heading = screen.getByRole('heading', { level: 1 })
      expect(heading).toBeTruthy()
      const id = await new IdbDefaultDocumentPointer().get()
      expect(id).not.toBeNull()
      return id as string
    })

    const warmupNode = textNodeCanvas('multi-canvas-warmup-a', 0, 0)

    // Warm up so the backend connection for A is confirmed live before we
    // exercise the race — re-fire until the write lands in loroCanvases (the
    // backend connects asynchronously with no sync signal).
    await waitFor(
      async () => {
        act(() => {
          latestOnChange!(warmupNode, setTextCommand('multi-canvas-warmup-a'))
        })
        // The warmup EDIT, not merely a record: every create path seeds one,
        // so a poll on the key existing stops retrying before anything lands.
        expect(await persistedNodeIds(idA)).toContain('multi-canvas-warmup-a')
      },
      { interval: 600 },
    )

    const lateEdit: SpatialCanvas = {
      nodes: [
        ...warmupNode.nodes,
        {
          id: 'multi-canvas-late-edit-a',
          type: 'text',
          x: 30,
          y: 30,
          width: 15,
          height: 15,
          text: 'x',
        },
      ],
      edges: [],
    }

    // Fire the late edit and, WITHOUT waiting for the 300ms debounce to
    // elapse, immediately create+switch to a fresh canvas B. The pending
    // debounced write for A must be flushed to A during the backend
    // teardown rather than cancelled and lost.
    act(() => {
      latestOnChange!(lateEdit, setTextCommand('multi-canvas-late-edit-a'))
    })

    await openDocument(pathB)

    const idB = await waitFor(async () => {
      const id = await new IdbDefaultDocumentPointer().get()
      expect(id).not.toBe(idA)
      return id as string
    })
    expect(idB).not.toBe(idA)

    // The late edit must have landed on A — verified by decoding straight
    // from IndexedDB, independent of the mock SpatialEditor's render timing.
    // The flushed write reaches IDB asynchronously (via the backend's write
    // queue), so this must be polled, never asserted immediately.
    await waitFor(async () => {
      const ids = await persistedNodeIds(idA)
      expect(ids).toContain('multi-canvas-late-edit-a')
    })

    // Never leaked into B.
    expect(await persistedNodeIds(idB)).not.toContain('multi-canvas-late-edit-a')
  })
})
