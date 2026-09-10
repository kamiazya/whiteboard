import { CHECKPOINT_QUIET_MS } from '@kamiazya/whiteboard-history'
import {
  writeSpatialCanvas,
  writeWorkspaceDocumentContent,
} from '@kamiazya/whiteboard-loro-adapter'
import type { DocumentKind } from '@kamiazya/whiteboard-model'
import { cleanup, render as rtlRender, screen, waitFor } from '@testing-library/react'
import { LoroDoc } from 'loro-crdt'
import type { ReactElement } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { userEvent } from 'vitest/browser'
import { BrowserVersionStore } from '../lib/browser-version-store.js'
import { BrowserWorkspaceDocs } from '../lib/browser-workspace-docs.js'
import { getBrowserWorkspaceId } from '../lib/browser-workspace-id.js'
import { FoldingBrowserIndex } from '../lib/folding-browser-index.js'
import { IdbDocumentIndex } from '../lib/idb-document-index.js'
import { clearWhiteboardDb } from '../test-utils/browser-document.js'
import { claimIsolatedWhiteboardDb } from '../test-utils/isolated-whiteboard-db.js'
import { seedIdbDocument } from '../test-utils/seed-idb-document.js'
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
/**
 * Which trigger is exercised for which kind of document, and why.
 *
 * This exists because the gap it closes was invisible: the quiet timer never
 * armed for a markdown note — the page reads the workspace record through
 * `backend`, and a markdown note deliberately has none — while this file
 * already passed, because the only test in it drove the `pagehide` flush on a
 * SPATIAL document. A feature wired for one kind, with the other kind's test
 * standing in for it, reads exactly like a covered feature.
 *
 * `satisfies Record<DocumentKind, ...>` is the part that has to be a type: a
 * third document kind cannot be added to the model without this table failing
 * to compile until someone says what checkpoints do for it. `not modelled` is
 * a legitimate answer, but only with a reason — a bare exemption is the
 * omission with a word in front of it.
 */
type Trigger = 'quiet-timer' | 'page-exit-flush'
type Coverage = 'covered' | `not modelled: ${string}`

const CHECKPOINT_COVERAGE = {
  spatial: {
    'quiet-timer': 'covered',
    'page-exit-flush': 'covered',
  },
  markdown: {
    'quiet-timer': 'covered',
    // The flush rides the same `checkpointPair` the quiet timer does, and its
    // spatial case above pins the ordering that is actually delicate (signal
    // before flush). What differs per kind is where the record comes from,
    // and the quiet-timer case above already exercises that for markdown.
    'page-exit-flush':
      "not modelled: same pair as the quiet timer above, which covers this kind's record source",
  },
} satisfies Record<DocumentKind, Record<Trigger, Coverage>>

/** Tallied by the run, so `covered` cannot be a claim nothing backs. */
const exercised = new Set<`${DocumentKind}/${Trigger}`>()

describe('BrowserDocumentPage automatic checkpoints (browser)', () => {
  afterAll(() => {
    const lying = Object.entries(CHECKPOINT_COVERAGE).flatMap(([kind, triggers]) =>
      Object.entries(triggers)
        .filter(
          ([trigger, claim]) =>
            claim === 'covered' && !exercised.has(`${kind}/${trigger}` as never),
        )
        .map(
          ([trigger]) => `${kind}/${trigger} is recorded as covered but the run never exercised it`,
        ),
    )
    expect(lying).toEqual([])
  })

  beforeEach(async () => {
    await clearWhiteboardDb()
  })

  afterEach(() => {
    cleanup()
  })

  it('leaves a checkpoint behind when the page goes away after an edit', async () => {
    exercised.add('spatial/page-exit-flush')
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
    exercised.add('spatial/quiet-timer')
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
    exercised.add('markdown/quiet-timer')
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
