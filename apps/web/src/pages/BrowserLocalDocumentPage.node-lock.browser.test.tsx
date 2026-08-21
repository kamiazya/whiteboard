/**
 * Node-lock reload persistence at the PAGE level (real IndexedDB). The
 * bridge, session, and editor each pass in isolation; this pins the
 * composition, which is where the lock was actually being dropped — the
 * session hydrate and the hook's initial subscribe both have to publish
 * the persisted lock set, or a lock reads as absent until the next toggle.
 *
 * SpatialEditor is mocked (same reasoning as the neighbouring page tests)
 * so the test can read `lockedNodeIds` straight off the props and drive
 * `onToggleNodeLock` without synthesising pointer input.
 */

import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { act, cleanup, render as rtlRender, screen, waitFor } from '@testing-library/react'
import type { ReactElement, ReactNode } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EditorCommand } from '../components/spatial-editor/commands.js'
import { IdbDocumentIndex } from '../lib/idb-document-index.js'
import {
  clearWhiteboardDb,
  createNodeCommand,
  textNodeCanvas,
} from '../test-utils/browser-local-document.js'
import '../index.css'
import { claimIsolatedWhiteboardDb } from '../test-utils/isolated-whiteboard-db.js'

claimIsolatedWhiteboardDb('browserlocaldocumentpage-node-lock')

function render(ui: ReactElement) {
  return rtlRender(
    <div style={{ height: '100vh' }}>
      <MemoryRouter initialEntries={['/']}>{ui}</MemoryRouter>
    </div>,
  )
}

type OnChange = (next: SpatialCanvas, command: EditorCommand) => void
type ToggleLock = (nodeId: string, locked: boolean) => void

let latestOnChange: OnChange | null = null
let latestToggleLock: ToggleLock | null = null
let latestLockedIds: ReadonlySet<string> = new Set()

vi.mock('../components/spatial-editor/index.js', () => ({
  SpatialEditor: (props: {
    canvas: SpatialCanvas
    onChange?: OnChange
    lockedNodeIds?: ReadonlySet<string>
    onToggleNodeLock?: ToggleLock
    paletteLeading?: ReactNode
  }) => {
    latestOnChange = props.onChange ?? null
    latestToggleLock = props.onToggleNodeLock ?? null
    latestLockedIds = props.lockedNodeIds ?? new Set()
    return <>{props.paletteLeading}</>
  },
}))

const { BrowserLocalDocumentPage } = await import('./BrowserLocalDocumentPage.js')

async function mountPage(): Promise<void> {
  render(<BrowserLocalDocumentPage store={new IdbDocumentIndex()} />)
  await waitFor(() => expect(screen.getByTestId('spatial-editor-container')).toBeInTheDocument(), {
    timeout: 5000,
  })
  await waitFor(() => expect(latestOnChange).not.toBeNull(), { timeout: 5000 })
}

describe('BrowserLocalDocumentPage node-lock reload persistence (browser — real IndexedDB)', () => {
  beforeEach(async () => {
    await clearWhiteboardDb()
    latestOnChange = null
    latestToggleLock = null
    latestLockedIds = new Set()
  })

  afterEach(cleanup)

  it('a lock toggled through the editor seam is still reported after a remount', async () => {
    await mountPage()

    // Seed a node, retried like the neighbouring tests: the editor renders
    // once the canvas metadata loads, before the session has hydrated, so an
    // early onChange lands on a doc that cannot commit it yet. Re-sending the
    // same canvas is a no-op.
    const created = textNodeCanvas('lock-probe', 20, 20)
    await waitFor(
      () => {
        act(() => {
          latestOnChange!(created, createNodeCommand('lock-probe', 20, 20))
        })
        expect(latestToggleLock).not.toBeNull()
      },
      { timeout: 10000, interval: 600 },
    )

    // Lock it, and confirm the page round-trips the state back to the editor
    // within this session before the reload leg is meaningful.
    await waitFor(
      () => {
        act(() => {
          latestToggleLock!('lock-probe', true)
        })
        expect([...latestLockedIds]).toContain('lock-probe')
      },
      { timeout: 10000, interval: 600 },
    )

    // Remount against the same store: this is the reload.
    cleanup()
    latestOnChange = null
    latestToggleLock = null
    latestLockedIds = new Set()
    await mountPage()

    await waitFor(
      () => {
        expect([...latestLockedIds]).toContain('lock-probe')
      },
      { timeout: 10000, interval: 300 },
    )
  })

  it('an unlock survives a remount too (the sidecar entry is really cleared)', async () => {
    await mountPage()
    const created = textNodeCanvas('unlock-probe', 40, 40)
    await waitFor(
      () => {
        act(() => {
          latestOnChange!(created, createNodeCommand('unlock-probe', 40, 40))
        })
        expect(latestToggleLock).not.toBeNull()
      },
      { timeout: 10000, interval: 600 },
    )
    await waitFor(
      () => {
        act(() => {
          latestToggleLock!('unlock-probe', true)
        })
        expect([...latestLockedIds]).toContain('unlock-probe')
      },
      { timeout: 10000, interval: 600 },
    )
    act(() => {
      latestToggleLock!('unlock-probe', false)
    })
    await waitFor(() => expect([...latestLockedIds]).not.toContain('unlock-probe'))

    cleanup()
    latestLockedIds = new Set(['stale'])
    latestOnChange = null
    await mountPage()
    await waitFor(() => expect([...latestLockedIds]).not.toContain('unlock-probe'), {
      timeout: 10000,
      interval: 300,
    })
  })
})
