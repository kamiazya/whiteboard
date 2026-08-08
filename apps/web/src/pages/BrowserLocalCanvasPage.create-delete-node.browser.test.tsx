/**
 * create-node/delete-node reload persistence (real IndexedDB), the page-level
 * complement to canvas-sync-session.test.ts's unit coverage: a node created
 * through the dedicated `create-node` fine-grained write survives a remount,
 * and a node removed through `delete-node` stays gone after another remount.
 *
 * SpatialEditor is mocked (see BrowserLocalCanvasPage.reload-elements.browser.test.tsx
 * for why) so the test can drive `onChange` deterministically with the exact
 * command shape a real create/delete gesture would report.
 */

import type { SpatialCanvas } from '@kamiazya/whiteboard-canvas-model'
import { act, cleanup, render as rtlRender, screen, waitFor } from '@testing-library/react'
import type { ReactElement } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EditorCommand } from '../components/spatial-editor/commands.js'
import { IndexedDBStore } from '../lib/browser-local-store.js'
import {
  clearWhiteboardDb,
  createNodeCommand,
  deleteNodeCommand,
  loroCanvasesKeys,
  persistedNodeIds,
  textNodeCanvas,
} from '../test-utils/browser-local-canvas.js'
import '../index.css'

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

describe('BrowserLocalCanvasPage create/delete-node reload persistence (browser — real IndexedDB)', () => {
  let canvasId = ''

  beforeEach(async () => {
    await clearWhiteboardDb()
    latestOnChange = null
    latestMountedCanvases = []
  })

  afterEach(() => {
    cleanup()
  })

  it('a node created via create-node survives remount; deleting it via delete-node stays gone after another remount', async () => {
    render(<BrowserLocalCanvasPage store={new IndexedDBStore()} />)
    await waitFor(
      () => expect(screen.getByTestId('spatial-editor-container')).toBeInTheDocument(),
      { timeout: 5000 },
    )
    await waitFor(() => expect(latestOnChange).not.toBeNull(), { timeout: 5000 })

    const created = textNodeCanvas('created-node', 20, 20)
    const createCmd = createNodeCommand('created-node', 20, 20)

    await waitFor(
      async () => {
        act(() => {
          latestOnChange!(created, createCmd)
        })
        const keys = await loroCanvasesKeys()
        expect(keys.length).toBeGreaterThan(0)
      },
      { timeout: 10000, interval: 600 },
    )
    const keys = await loroCanvasesKeys()
    canvasId = keys.find((k) => k !== '__placeholder__')!
    expect(canvasId).toBeDefined()
    await waitFor(
      async () => {
        expect(await persistedNodeIds(canvasId)).toContain('created-node')
      },
      { timeout: 10000, interval: 600 },
    )

    cleanup()
    latestMountedCanvases = []
    render(<BrowserLocalCanvasPage store={new IndexedDBStore()} />)
    await waitFor(
      () => expect(screen.getByTestId('spatial-editor-container')).toBeInTheDocument(),
      { timeout: 5000 },
    )
    await waitFor(
      () => {
        const restoredIds = latestMountedCanvases.flatMap((canvas) => canvas.nodes.map((n) => n.id))
        expect(restoredIds).toContain('created-node')
      },
      { timeout: 5000 },
    )

    // Now delete it and confirm it stays gone after a further remount.
    await waitFor(() => expect(latestOnChange).not.toBeNull(), { timeout: 5000 })
    const afterDelete: SpatialCanvas = { nodes: [], edges: [] }
    const deleteCmd = deleteNodeCommand('created-node')
    await waitFor(
      async () => {
        act(() => {
          latestOnChange!(afterDelete, deleteCmd)
        })
        expect(await persistedNodeIds(canvasId)).not.toContain('created-node')
      },
      { timeout: 10000, interval: 600 },
    )

    cleanup()
    latestMountedCanvases = []
    render(<BrowserLocalCanvasPage store={new IndexedDBStore()} />)
    await waitFor(
      () => expect(screen.getByTestId('spatial-editor-container')).toBeInTheDocument(),
      { timeout: 5000 },
    )
    await waitFor(
      () => {
        const restoredIds = latestMountedCanvases.flatMap((canvas) => canvas.nodes.map((n) => n.id))
        expect(restoredIds).not.toContain('created-node')
      },
      { timeout: 5000 },
    )
  })
})
