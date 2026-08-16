/**
 * S-C2 multi-canvas UI (real IndexedDB): edit canvas A, create+switch to a
 * fresh empty canvas B via the page's New-canvas control, switch back to A via
 * the switcher, and confirm A's node is restored. Proves the switcher/New
 * UI drives the S-C1 store+controller API end to end, including the
 * useCanvasSync reconnect-on-backend-identity-change path.
 *
 * SpatialEditor is mocked (see BrowserLocalCanvasPage.reload-elements.browser.test.tsx's
 * doc comment for why) so edits are driven deterministically via onChange —
 * this suite's subject is the backend/IndexedDB sync layer, not gesture input.
 */

import type { SpatialCanvas } from '@kamiazya/whiteboard-canvas-model'
import {
  act,
  cleanup,
  fireEvent,
  render as rtlRender,
  screen,
  waitFor,
} from '@testing-library/react'
import type { ReactElement } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EditorCommand } from '../components/spatial-editor/commands.js'
import { IndexedDBStore } from '../lib/browser-local-store.js'
import {
  clearWhiteboardDb,
  loroCanvasesKeys,
  persistedNodeIds,
  setTextCommand,
  textNodeCanvas,
} from '../test-utils/browser-local-canvas.js'
import '../index.css'

// The page reads/writes the canvas id through the router, so it needs a router
// in scope exactly as it has one in main.tsx.
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
  SpatialEditor: (props: { canvas: SpatialCanvas; onChange?: OnChange }) => {
    latestOnChange = props.onChange ?? null
    latestMountedCanvases.push(props.canvas)
    return null
  },
}))

const { BrowserLocalCanvasPage } = await import('./BrowserLocalCanvasPage.js')

describe('BrowserLocalCanvasPage multi-canvas UI (browser — real IndexedDB)', () => {
  beforeEach(async () => {
    await clearWhiteboardDb()
    latestOnChange = null
    latestMountedCanvases = []
  })

  afterEach(() => {
    cleanup()
  })

  it('edits A, New switches to empty B, switching back to A restores the edited node', async () => {
    const store = new IndexedDBStore()
    render(<BrowserLocalCanvasPage store={store} />)
    await waitFor(
      () => expect(screen.getByTestId('spatial-editor-container')).toBeInTheDocument(),
      {
        timeout: 5000,
      },
    )
    await waitFor(() => expect(latestOnChange).not.toBeNull(), { timeout: 5000 })

    const idA = await waitFor(
      async () => {
        const heading = screen.getByRole('heading', { level: 1 })
        expect(heading).toBeTruthy()
        const id = await store.getDefaultCanvasId()
        expect(id).not.toBeNull()
        return id as string
      },
      { timeout: 5000 },
    )

    const nodeA = textNodeCanvas('multi-canvas-node-a', 10, 10)

    // Re-fire until the write lands in loroCanvases (see reload-elements test
    // for why: the backend connects asynchronously with no sync signal).
    await waitFor(
      async () => {
        act(() => {
          latestOnChange!(nodeA, setTextCommand('multi-canvas-node-a'))
        })
        const keys = await loroCanvasesKeys()
        expect(keys).toContain(idA)
      },
      { timeout: 10000, interval: 600 },
    )

    // Create canvas B and switch to it, via WorkspaceTopBar's switcher dropdown.
    const switcherA = await screen.findByRole('button', { name: /^Workspace:/i })
    fireEvent.pointerDown(switcherA, { button: 0, ctrlKey: false })
    const newItem = await screen.findByTestId('new-canvas-menu-item')
    await act(async () => {
      fireEvent.pointerUp(newItem)
    })

    const idB = await waitFor(
      async () => {
        const id = await store.getDefaultCanvasId()
        expect(id).not.toBe(idA)
        return id as string
      },
      { timeout: 5000 },
    )

    // B is a fresh canvas: its persisted doc must never contain A's node —
    // asserted straight from IndexedDB so the check is independent of the
    // mock SpatialEditor's render timing.
    expect(await persistedNodeIds(idB)).not.toContain('multi-canvas-node-a')

    // No stray placeholder row from the backend re-key.
    expect(await loroCanvasesKeys()).not.toContain('__placeholder__')

    // Switch back to A via the switcher control. Both A and B default to the
    // "untitled" display name, so disambiguate by the raw id shown in each
    // menu item's subtitle line (only rendered when the name differs from
    // the path/id, which it always does for a browser-local canvas).
    const switcherB = await screen.findByRole('button', { name: /^Workspace:/i })
    fireEvent.pointerDown(switcherB, { button: 0, ctrlKey: false })
    const idALabel = await screen.findByText(idA)
    const itemA = idALabel.closest('[role="menuitem"]') as HTMLElement
    // `latestMountedCanvases` accumulates every mount, including the one from
    // when A was originally open. Only mounts recorded from here on can show
    // that switching BACK re-hydrated A — searching the whole history would
    // pass even if the switch mounted nothing at all.
    const mountsBeforeSwitchBack = latestMountedCanvases.length
    await act(async () => {
      fireEvent.pointerUp(itemA)
    })

    await waitFor(
      () => {
        const restoredIds = latestMountedCanvases
          .slice(mountsBeforeSwitchBack)
          .flatMap((canvas) => canvas.nodes.map((n) => n.id))
        expect(restoredIds).toContain('multi-canvas-node-a')
      },
      { timeout: 5000 },
    )

    expect(await loroCanvasesKeys()).not.toContain('__placeholder__')
  })

  it('persists an edit made immediately (within the 300ms debounce window) before switching to a new canvas', async () => {
    const store = new IndexedDBStore()
    render(<BrowserLocalCanvasPage store={store} />)
    await waitFor(
      () => expect(screen.getByTestId('spatial-editor-container')).toBeInTheDocument(),
      {
        timeout: 5000,
      },
    )
    await waitFor(() => expect(latestOnChange).not.toBeNull(), { timeout: 5000 })

    const idA = await waitFor(
      async () => {
        const heading = screen.getByRole('heading', { level: 1 })
        expect(heading).toBeTruthy()
        const id = await store.getDefaultCanvasId()
        expect(id).not.toBeNull()
        return id as string
      },
      { timeout: 5000 },
    )

    const warmupNode = textNodeCanvas('multi-canvas-warmup-a', 0, 0)

    // Warm up so the backend connection for A is confirmed live before we
    // exercise the race — re-fire until the write lands in loroCanvases (the
    // backend connects asynchronously with no sync signal).
    await waitFor(
      async () => {
        act(() => {
          latestOnChange!(warmupNode, setTextCommand('multi-canvas-warmup-a'))
        })
        const keys = await loroCanvasesKeys()
        expect(keys).toContain(idA)
      },
      { timeout: 10000, interval: 600 },
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

    const switcherA = await screen.findByRole('button', { name: /^Workspace:/i })
    fireEvent.pointerDown(switcherA, { button: 0, ctrlKey: false })
    const newItem = await screen.findByTestId('new-canvas-menu-item')
    await act(async () => {
      fireEvent.pointerUp(newItem)
    })

    const idB = await waitFor(
      async () => {
        const id = await store.getDefaultCanvasId()
        expect(id).not.toBe(idA)
        return id as string
      },
      { timeout: 5000 },
    )
    expect(idB).not.toBe(idA)

    // The late edit must have landed on A — verified by decoding straight
    // from IndexedDB, independent of the mock SpatialEditor's render timing.
    // The flushed write reaches IDB asynchronously (via the backend's write
    // queue), so this must be polled, never asserted immediately.
    await waitFor(
      async () => {
        const ids = await persistedNodeIds(idA)
        expect(ids).toContain('multi-canvas-late-edit-a')
      },
      { timeout: 5000 },
    )

    // Never leaked into B.
    expect(await persistedNodeIds(idB)).not.toContain('multi-canvas-late-edit-a')
  })
})
