/**
 * create-node/delete-node reload persistence (real IndexedDB), the page-level
 * complement to document-sync-session.test.ts's unit coverage: a node created
 * through the dedicated `create-node` fine-grained write survives a remount,
 * and a node removed through `delete-node` stays gone after another remount.
 *
 * SpatialEditor is mocked (see BrowserLocalDocumentPage.reload-elements.browser.test.tsx
 * for why) so the test can drive `onChange` deterministically with the exact
 * command shape a real create/delete gesture would report.
 */

// jsdom + fake-indexeddb: this suite drives page wiring over IndexedDB
// persistence with the spatial editor mocked — no browser layout or input
// fidelity at stake. The real-IDB contract stays pinned by the four
// browser-mode keeper suites (see loro-store.browser.test.tsx).
import { IdbDefaultDocumentPointer } from '../lib/local-document-summary.js'
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
import type { ReactElement, ReactNode } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EditorCommand } from '../components/spatial-editor/commands.js'
import { IdbDocumentIndex } from '../lib/idb-document-index.js'
import {
  clearWhiteboardDb,
  createNodeCommand,
  deleteNodeCommand,
  persistedNodeIds,
  textNodeCanvas,
} from '../test-utils/browser-local-document.js'
import '../index.css'
import { claimIsolatedWhiteboardDb } from '../test-utils/isolated-whiteboard-db.js'

claimIsolatedWhiteboardDb('browserlocaldocumentpage-create-delete-node')

function render(ui: ReactElement) {
  return rtlRender(
    // Pages fill their allotted height (h-full) — the app shell owns the
    // viewport in production, so tests supply the equivalent sized parent.
    <div style={{ height: '100vh' }}>
      <MemoryRouter initialEntries={['/']}>{ui}</MemoryRouter>
    </div>,
  )
}

type OnChange = (next: SpatialCanvas, command: EditorCommand) => void

let latestOnChange: OnChange | null = null
let latestMountedCanvases: SpatialCanvas[] = []

vi.mock('../components/spatial-editor/index.js', () => ({
  SpatialEditor: (props: {
    canvas: SpatialCanvas
    onChange?: OnChange
    paletteLeading?: ReactNode
  }) => {
    latestOnChange = props.onChange ?? null
    latestMountedCanvases.push(props.canvas)
    // The real editor docks host controls (undo/redo) via paletteLeading;
    // the stub must render them or the page's history buttons vanish.
    return <>{props.paletteLeading}</>
  },
}))

const { BrowserLocalDocumentPage } = await import('./BrowserLocalDocumentPage.js')

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

describe('BrowserLocalDocumentPage create/delete-node persistence (real IndexedDB)', () => {
  let documentId = ''

  beforeEach(async () => {
    await clearWhiteboardDb()
    latestOnChange = null
    latestMountedCanvases = []
  })

  afterEach(() => {
    cleanup()
  })

  it('tapping Undo in the history cluster reverts the last committed edit', async () => {
    // The mobile path: no keyboard exists, so the cluster button must drive
    // the same Loro UndoManager the Cmd/Ctrl+Z shortcut does.
    render(<BrowserLocalDocumentPage store={new IdbDocumentIndex()} />)
    await waitFor(() => expect(screen.getByTestId('spatial-editor-container')).toBeTruthy())
    await waitFor(() => expect(latestOnChange).not.toBeNull())

    const created = textNodeCanvas('undo-probe-node', 20, 20)
    // Retried like the neighboring tests: the editor renders as soon as the
    // canvas metadata loads, which is before the session has hydrated, so an
    // early onChange lands on a doc that is not ready to commit it.
    // Re-sending an identical canvas is a no-op on the doc, so retries never
    // stack extra undo steps.
    const undoButton = screen.getByRole('button', { name: 'Undo' })
    await waitFor(
      () => {
        act(() => {
          latestOnChange!(created, createNodeCommand('undo-probe-node', 20, 20))
        })
        expect(undoButton.getAttribute('aria-disabled')).toBe('false')
      },
      { interval: 600 },
    )

    act(() => {
      undoButton.click()
    })

    await waitFor(() => {
      const latest = latestMountedCanvases.at(-1)
      expect(latest).toBeDefined()
      expect(latest!.nodes.map((n) => n.id)).not.toContain('undo-probe-node')
    })
    // And redo brings it back through the same cluster.
    const redoButton = screen.getByRole('button', { name: 'Redo' })
    await waitFor(() => expect(redoButton.getAttribute('aria-disabled')).toBe('false'))
    act(() => {
      redoButton.click()
    })
    await waitFor(() => {
      const latest = latestMountedCanvases.at(-1)
      expect(latest!.nodes.map((n) => n.id)).toContain('undo-probe-node')
    })
  })

  it('a created node survives remount, and a deleted one stays gone', async () => {
    render(<BrowserLocalDocumentPage store={new IdbDocumentIndex()} />)
    await waitFor(() => expect(screen.getByTestId('spatial-editor-container')).toBeTruthy())
    await waitFor(() => expect(latestOnChange).not.toBeNull())

    const created = textNodeCanvas('created-node', 20, 20)
    const createCmd = createNodeCommand('created-node', 20, 20)

    // The document the EDITOR has open, not "the first key in the store".
    // Measured under a full-suite run: two documents existed by this point and
    // the poll was watching the one nothing was writing to — `nodes=[]`
    // forever, while the edits landed in the other. The default pointer is the
    // handle this page actually uses, so it is the one to ask.
    documentId = (await new IdbDefaultDocumentPointer().get()) ?? ''
    expect(documentId).not.toBe('')
    // The re-fire and the content check are ONE wait. Every create path now
    // seeds an empty content record, so a poll on "a key exists" is satisfied
    // before any edit lands and stops retrying — leaving a single dispatch
    // that may have raced the backend's connection, and a content check with
    // nothing left to re-fire it.
    await waitFor(
      async () => {
        act(() => {
          latestOnChange!(created, createCmd)
        })
        expect(await persistedNodeIds(documentId)).toContain('created-node')
      },
      { interval: 600 },
    )

    cleanup()
    latestMountedCanvases = []
    render(<BrowserLocalDocumentPage store={new IdbDocumentIndex()} />)
    await waitFor(() => expect(screen.getByTestId('spatial-editor-container')).toBeTruthy())
    await waitFor(
      () => {
        const restoredIds = latestMountedCanvases.flatMap((canvas) => canvas.nodes.map((n) => n.id))
        expect(restoredIds).toContain('created-node')
      },
      // The RELOAD's budget, not the mount's. Reading a document back is two
      // IndexedDB round trips behind the `DocumentStore` port plus a Loro
      // import, and under fake-indexeddb on a loaded runner that does not fit
      // the 5s the first mount is given. Measured: green locally, red in CI.,
    )

    // Now delete it and confirm it stays gone after a further remount.
    await waitFor(() => expect(latestOnChange).not.toBeNull())
    const afterDelete: SpatialCanvas = { nodes: [], edges: [] }
    const deleteCmd = deleteNodeCommand('created-node')
    await waitFor(
      async () => {
        act(() => {
          latestOnChange!(afterDelete, deleteCmd)
        })
        expect(await persistedNodeIds(documentId)).not.toContain('created-node')
      },
      { interval: 600 },
    )

    cleanup()
    latestMountedCanvases = []
    render(<BrowserLocalDocumentPage store={new IdbDocumentIndex()} />)
    await waitFor(() => expect(screen.getByTestId('spatial-editor-container')).toBeTruthy())
    await waitFor(() => {
      const restoredIds = latestMountedCanvases.flatMap((canvas) => canvas.nodes.map((n) => n.id))
      expect(restoredIds).not.toContain('created-node')
    })
  })
})
