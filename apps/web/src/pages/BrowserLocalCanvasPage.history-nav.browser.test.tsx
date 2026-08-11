/**
 * Browser Back/Forward must round-trip through the loaded canvas, not just
 * the address bar: create+switch to a second canvas, go Back to the first
 * (proving the URL->switchCanvas direction fires), then Forward to the
 * second again.
 *
 * SpatialEditor is mocked (see BrowserLocalCanvasPage.reload-elements.browser.test.tsx's
 * doc comment for why) so each canvas's edit is driven deterministically via
 * onChange — this suite's subject is router<->canvas-id sync, not gesture
 * input.
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
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EditorCommand } from '../components/spatial-editor/commands.js'
import { IndexedDBStore } from '../lib/browser-local-store.js'
import {
  clearWhiteboardDb,
  persistedNodeIds,
  setTextCommand,
  textNodeCanvas,
} from '../test-utils/browser-local-canvas.js'
import '../index.css'

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

const { BrowserLocalCanvasPage } = await import('./BrowserLocalCanvasPage.js')

describe('BrowserLocalCanvasPage browser Back/Forward (browser — real IndexedDB)', () => {
  beforeEach(async () => {
    await clearWhiteboardDb()
    latestOnChange = null
  })

  afterEach(() => {
    cleanup()
  })

  it('Back returns to the first canvas and Forward returns to the second', async () => {
    const store = new IndexedDBStore()
    const router = createMemoryRouter(
      [{ path: '*', element: <BrowserLocalCanvasPage store={store} /> }],
      { initialEntries: ['/'] },
    )
    rtlRender(
      <div style={{ height: '100vh' }}>
        <RouterProvider router={router} />
      </div>,
    )

    await waitFor(
      () => expect(screen.getByTestId('spatial-editor-container')).toBeInTheDocument(),
      {
        timeout: 5000,
      },
    )
    await waitFor(() => expect(latestOnChange).not.toBeNull(), { timeout: 5000 })

    const idA = await waitFor(
      async () => {
        const id = await store.getDefaultCanvasId()
        expect(id).not.toBeNull()
        return id as string
      },
      { timeout: 5000 },
    )

    const nodeA = textNodeCanvas('history-nav-node-a', 0, 0)
    await waitFor(
      async () => {
        act(() => {
          latestOnChange!(nodeA, setTextCommand('history-nav-node-a'))
        })
        expect(await persistedNodeIds(idA)).toContain('history-nav-node-a')
      },
      { timeout: 10000, interval: 600 },
    )

    // Create canvas B via the switcher's New-canvas control.
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

    await waitFor(() => expect(router.state.location.pathname).toBe(`/local/${idB}`), {
      timeout: 5000,
    })

    const nodeB = textNodeCanvas('history-nav-node-b', 20, 20)
    await waitFor(
      async () => {
        act(() => {
          latestOnChange!(nodeB, setTextCommand('history-nav-node-b'))
        })
        expect(await persistedNodeIds(idB)).toContain('history-nav-node-b')
      },
      { timeout: 10000, interval: 600 },
    )

    // Back: real browser Back/Forward drives router history the same way
    // router.navigate(-1) does — a POP navigation the component never
    // triggers itself.
    await act(async () => {
      await router.navigate(-1)
    })

    await waitFor(() => expect(router.state.location.pathname).toBe(`/local/${idA}`), {
      timeout: 5000,
    })
    await waitFor(
      async () => {
        expect(await store.getDefaultCanvasId()).toBe(idA)
      },
      { timeout: 5000 },
    )
    await waitFor(() => expect(screen.getByRole('heading', { level: 1 })).toBeInTheDocument())
    // The editor must actually be showing canvas A now — the assertions above
    // only establish that the navigation and the store agree about which
    // canvas is current.
    await waitFor(() => expect(mountedNodeIds()).toContain('history-nav-node-a'), { timeout: 5000 })
    expect(mountedNodeIds()).not.toContain('history-nav-node-b')

    // Forward: back to B.
    await act(async () => {
      await router.navigate(1)
    })

    await waitFor(() => expect(router.state.location.pathname).toBe(`/local/${idB}`), {
      timeout: 5000,
    })
    await waitFor(
      async () => {
        expect(await store.getDefaultCanvasId()).toBe(idB)
      },
      { timeout: 5000 },
    )
    await waitFor(() => expect(mountedNodeIds()).toContain('history-nav-node-b'), { timeout: 5000 })
    expect(mountedNodeIds()).not.toContain('history-nav-node-a')
  })
})
