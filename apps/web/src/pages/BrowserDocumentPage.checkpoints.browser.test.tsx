import {
  writeSpatialCanvas,
  writeWorkspaceDocumentContent,
} from '@kamiazya/whiteboard-loro-adapter'
import { cleanup, render as rtlRender, screen, waitFor } from '@testing-library/react'
import { LoroDoc } from 'loro-crdt'
import type { ReactElement } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { CHECKPOINT_QUIET_MS } from '@kamiazya/whiteboard-history'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { userEvent } from 'vitest/browser'
import { BrowserVersionStore } from '../lib/browser-version-store.js'
import { BrowserWorkspaceDocs } from '../lib/browser-workspace-docs.js'
import { getBrowserWorkspaceId } from '../lib/browser-workspace-id.js'
import { FoldingBrowserIndex } from '../lib/folding-browser-index.js'
import { IdbDocumentIndex } from '../lib/idb-document-index.js'
import { seedIdbDocument } from '../test-utils/seed-idb-document.js'
import { clearWhiteboardDb } from '../test-utils/browser-document.js'
import { claimIsolatedWhiteboardDb } from '../test-utils/isolated-whiteboard-db.js'
import { BrowserDocumentPage } from './BrowserDocumentPage.js'
import '../index.css'

claimIsolatedWhiteboardDb('browserdocumentpagecheckpoints')

function render(ui: ReactElement) {
  return rtlRender(
    <div style={{ height: '100vh' }}>
      <MemoryRouter initialEntries={['/']}>{ui}</MemoryRouter>
    </div>,
  )
}

async function seedDocument(): Promise<{ index: FoldingBrowserIndex; documentId: string }> {
  const index = new FoldingBrowserIndex()
  const workspaceId = getBrowserWorkspaceId()
  await index.createWorkspace({ workspaceId })
  const { documentId } = await index.createDocument({
    workspaceId,
    path: 'canvas-a',
    kind: 'spatial',
  })
  const doc = new LoroDoc()
  writeSpatialCanvas(doc, {
    nodes: [{ id: 'n1', type: 'text', x: 0, y: 0, width: 80, height: 40, text: 'first' }],
    edges: [],
  })
  doc.commit()
  const docs = new BrowserWorkspaceDocs()
  const record = await docs.open(workspaceId)
  if (record === null) throw new Error('no record')
  writeWorkspaceDocumentContent(record, documentId, doc)
  await docs.save(workspaceId, record)
  return { index, documentId }
}

// Automatic checkpoints in browser mode, end to end through the real page.
// The scheduler's own quiet window is five minutes, so what this drives is
// the OTHER way a checkpoint lands: the page going away. That is not a
// shortcut around the debounce — it is the case a person actually hits, and
// the one the daemon has no equivalent of.
describe('BrowserDocumentPage automatic checkpoints (browser)', () => {
  beforeEach(async () => {
    await clearWhiteboardDb()
  })

  afterEach(() => {
    cleanup()
  })

  it('leaves a checkpoint behind when the page goes away after an edit', async () => {
    const { index } = await seedDocument()
    render(<BrowserDocumentPage initialPath="canvas-a" />)
    await waitFor(
      () => expect(screen.getByTestId('spatial-editor-container')).toBeInTheDocument(),
      {
        timeout: 5000,
      },
    )

    const store = new BrowserVersionStore({ docs: new BrowserWorkspaceDocs(), index })
    const workspaceId = getBrowserWorkspaceId()
    // Nothing yet: an untouched document has no checkpoint, which is what
    // makes the row below evidence of the edit rather than of mounting.
    expect(await store.list(workspaceId, 'canvas-a')).toEqual([])

    // A real edit through the editor, not a write straight to the store.
    await userEvent.click(await screen.findByTestId('select-tool-button'))
    await userEvent.dblClick(screen.getByTestId('spatial-editor-container'))

    // Immediately, with the edit still inside the debounce window — which is
    // what a person closing a tab does, and the ordering this pins. The
    // commit the edit flush performs reaches `subscribeLocalUpdates` on a
    // LATER microtask, so a checkpoint flush that ran here would find nothing
    // armed and leave no row.
    window.dispatchEvent(new Event('pagehide'))

    await waitFor(
      async () => {
        const rows = await store.list(workspaceId, 'canvas-a')
        expect(rows).toEqual([expect.objectContaining({ auto: true, branchName: 'main' })])
      },
      { timeout: 5000 },
    )
  })

  // The OTHER trigger, and the one a person actually meets: the panel promises
  // "a checkpoint is saved a little after you stop editing", and that is the
  // quiet timer rather than the page-exit flush above. Nothing exercised it —
  // the flush test passing is what made the feature look covered — and in the
  // running app no checkpoint ever appears: measured at 7 minutes of real idle
  // against a 5-minute threshold, surviving a reload, with no console output.
  it('leaves a checkpoint behind once the document has been quiet, without any page exit', async () => {
    const { index } = await seedDocument()
    // Armed before the edit: the timer this test is about is scheduled by the
    // edit itself, and timers already pending when fake time is installed are
    // not captured. `shouldAdvanceTime` keeps real time moving so the async
    // IndexedDB work either side of the edit still settles.
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      render(<BrowserDocumentPage initialPath="canvas-a" />)
      await waitFor(
        () => expect(screen.getByTestId('spatial-editor-container')).toBeInTheDocument(),
        {
          timeout: 5000,
        },
      )

      const store = new BrowserVersionStore({ docs: new BrowserWorkspaceDocs(), index })
      const workspaceId = getBrowserWorkspaceId()
      expect(await store.list(workspaceId, 'canvas-a')).toEqual([])

      await userEvent.click(await screen.findByTestId('select-tool-button'))
      await userEvent.dblClick(screen.getByTestId('spatial-editor-container'))

      // Past the quiet threshold, and nothing else: no pagehide, no unmount,
      // no navigation. Only stopping typing.
      await vi.advanceTimersByTimeAsync(CHECKPOINT_QUIET_MS + 1_000)

      await waitFor(
        async () => {
          const rows = await store.list(workspaceId, 'canvas-a')
          expect(rows).toEqual([expect.objectContaining({ auto: true, branchName: 'main' })])
        },
        { timeout: 5000 },
      )
    } finally {
      vi.useRealTimers()
    }
  })

  // The same quiet timer for a MARKDOWN document. Both kinds mount this page
  // and both are promised the same behaviour by the same panel, but they take
  // different content paths, and every hand-check that found no checkpoint
  // used a markdown note.
  it('leaves a checkpoint behind once a markdown document has been quiet', async () => {
    const index = new IdbDocumentIndex()
    await seedIdbDocument(index, { path: 'note', kind: 'markdown', makeDefault: true })
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      render(<BrowserDocumentPage store={index} />)
      const editable = await waitFor(() => {
        const el = document.querySelector('[contenteditable="true"]')
        expect(el).not.toBeNull()
        return el as HTMLElement
      })

      const store = new BrowserVersionStore({ docs: new BrowserWorkspaceDocs(), index })
      const workspaceId = getBrowserWorkspaceId()
      expect(await store.list(workspaceId, 'note')).toEqual([])

      await userEvent.click(editable)
      await userEvent.type(editable, 'quiet timer probe')

      await vi.advanceTimersByTimeAsync(CHECKPOINT_QUIET_MS + 1_000)

      await waitFor(
        async () => {
          const rows = await store.list(workspaceId, 'note')
          expect(rows).toEqual([expect.objectContaining({ auto: true })])
        },
        { timeout: 5000 },
      )
    } finally {
      vi.useRealTimers()
    }
  })
})
