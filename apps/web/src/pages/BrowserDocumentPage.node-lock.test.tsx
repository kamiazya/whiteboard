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

// jsdom + fake-indexeddb: this suite drives page wiring over IndexedDB
// persistence with the spatial editor mocked — no browser layout or input
// fidelity at stake. The real-IDB contract stays pinned by the four
// browser-mode keeper suites (see loro-store.browser.test.tsx).
import 'fake-indexeddb/auto'
import { readNodeLocks } from '@kamiazya/whiteboard-loro-adapter'
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import {
  act,
  cleanup,
  configure,
  render as rtlRender,
  screen,
  waitFor,
} from '@testing-library/react'
import { Loro } from 'loro-crdt'
import type { ReactElement, ReactNode } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EditorCommand } from '../components/spatial-editor/commands.js'
import { IdbDocumentIndex } from '../lib/idb-document-index.js'
import { IdbDefaultDocumentPointer } from '../lib/local-document-summary.js'
import { LoroStore } from '../lib/loro-store.js'
import {
  clearWhiteboardDb,
  createNodeCommand,
  persistedNodeIds,
  textNodeCanvas,
} from '../test-utils/browser-document.js'
import '../index.css'
import { claimIsolatedWhiteboardDb } from '../test-utils/isolated-whiteboard-db.js'

claimIsolatedWhiteboardDb('browserdocumentpage-node-lock')

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

const { BrowserDocumentPage } = await import('./BrowserDocumentPage.js')

async function mountPage(): Promise<void> {
  render(<BrowserDocumentPage store={new IdbDocumentIndex()} />)
  await waitFor(() => expect(screen.getByTestId('spatial-editor-container')).toBeTruthy())
  await waitFor(() => expect(latestOnChange).not.toBeNull())
}

/**
 * Resolve once the current default document's STORED content agrees.
 *
 * Reads through `LoroStore`, so it sees exactly what a reload will: the
 * snapshot plus every delta the write path has committed so far. The
 * in-session lock set is not that — it is updated synchronously by the toggle,
 * and the write follows behind it.
 */
async function waitForStoredLocks(want: 'some' | 'none'): Promise<void> {
  // Testing Library's `waitFor`, not vitest's. `configure({ asyncUtilTimeout })`
  // at the top of this file governs the former only — `vi.waitFor` defaults to
  // 1000ms, which at this file's 200ms interval is about five attempts for the
  // one condition the remount below depends on.
  await waitFor(
    async () => {
      const id = (await new IdbDefaultDocumentPointer().get()) ?? ''
      const loaded = await new LoroStore().load(id)
      expect(loaded.kind).toBe('ok')
      if (loaded.kind !== 'ok') return
      const doc = new Loro()
      doc.import(loaded.snapshot)
      for (const delta of loaded.deltas ?? []) doc.import(delta)
      const locked = readNodeLocks(doc).size
      if (want === 'some') expect(locked).toBeGreaterThan(0)
      else expect(locked).toBe(0)
    },
    { interval: 200 },
  )
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

describe('BrowserDocumentPage node-lock reload persistence (browser — real IndexedDB)', () => {
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
      async () => {
        act(() => {
          latestOnChange!(created, createNodeCommand('lock-probe', 20, 20))
        })
        expect(latestToggleLock).not.toBeNull()
        // AND the node actually persisted: the remount below reads storage,
        // so a wait that only proves the seam is wired lets it read a
        // document the edit has not reached yet.
        expect(
          await persistedNodeIds((await new IdbDefaultDocumentPointer().get()) ?? ''),
        ).toContain('lock-probe')
      },
      { interval: 600 },
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
      { interval: 600 },
    )

    // The lock has to be PERSISTED before the reload, not merely reported
    // in-session: `setNodeLock` updates the live doc synchronously and the
    // write follows it. Reading storage is the only thing that says the write
    // landed — and going through the `DocumentStore` port made that write
    // three IndexedDB round trips instead of one, so the window this closes
    // is real and wide. Measured without it: both appends ran, and the reload
    // still read a document with one delta and no lock.
    await waitForStoredLocks('some')

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
      { interval: 300 },
    )
  })

  it('an unlock survives a remount too (the sidecar entry is really cleared)', async () => {
    await mountPage()
    const created = textNodeCanvas('unlock-probe', 40, 40)
    await waitFor(
      async () => {
        act(() => {
          latestOnChange!(created, createNodeCommand('unlock-probe', 40, 40))
        })
        expect(latestToggleLock).not.toBeNull()
        // AND the node actually persisted: the remount below reads storage,
        // so a wait that only proves the seam is wired lets it read a
        // document the edit has not reached yet.
        expect(
          await persistedNodeIds((await new IdbDefaultDocumentPointer().get()) ?? ''),
        ).toContain('unlock-probe')
      },
      { interval: 600 },
    )
    await waitFor(
      () => {
        act(() => {
          latestToggleLock!('unlock-probe', true)
        })
        expect([...latestLockedIds]).toContain('unlock-probe')
      },
      { interval: 600 },
    )
    act(() => {
      latestToggleLock!('unlock-probe', false)
    })
    await waitFor(() => expect([...latestLockedIds]).not.toContain('unlock-probe'))
    // Same reason as above, in the other direction: the UNLOCK has to have
    // reached storage before the reload reads it.
    await waitForStoredLocks('none')

    cleanup()
    latestLockedIds = new Set(['stale'])
    latestOnChange = null
    await mountPage()
    await waitFor(() => expect([...latestLockedIds]).not.toContain('unlock-probe'), {
      interval: 300,
    })
  })
})
