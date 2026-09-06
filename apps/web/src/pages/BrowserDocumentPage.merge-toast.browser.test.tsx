import {
  projectWorkspaceDocument,
  readSpatialCanvas,
  writeSpatialCanvas,
  writeWorkspaceDocumentContent,
} from '@kamiazya/whiteboard-loro-adapter'
import { cleanup, render as rtlRender, screen, waitFor } from '@testing-library/react'
import { LoroDoc } from 'loro-crdt'
import type { ReactElement } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { userEvent } from 'vitest/browser'
import { BrowserVersionStore } from '../lib/browser-version-store.js'
import { BrowserWorkspaceDocs } from '../lib/browser-workspace-docs.js'
import { getBrowserWorkspaceId } from '../lib/browser-workspace-id.js'
import { FoldingBrowserIndex } from '../lib/folding-browser-index.js'
import { dispatchMergeCommitted } from '../lib/merge-committed-event.js'
import { clearWhiteboardDb } from '../test-utils/browser-document.js'
import { claimIsolatedWhiteboardDb } from '../test-utils/isolated-whiteboard-db.js'
import { BrowserDocumentPage } from './BrowserDocumentPage.js'
import '../index.css'

claimIsolatedWhiteboardDb('browserdocumentpagemergetoast')

function render(ui: ReactElement) {
  return rtlRender(
    <div style={{ height: '100vh' }}>
      <MemoryRouter initialEntries={['/']}>{ui}</MemoryRouter>
    </div>,
  )
}

function textDoc(text: string): LoroDoc {
  const doc = new LoroDoc()
  writeSpatialCanvas(doc, {
    nodes: [{ id: 'n1', type: 'text', x: 0, y: 0, width: 80, height: 40, text }],
    edges: [],
  })
  doc.commit()
  return doc
}

async function writeContent(documentId: string, text: string): Promise<void> {
  const docs = new BrowserWorkspaceDocs()
  const record = await docs.open(getBrowserWorkspaceId())
  if (record === null) throw new Error('no record')
  writeWorkspaceDocumentContent(record, documentId, textDoc(text))
  await docs.save(getBrowserWorkspaceId(), record)
}

async function storedText(documentId: string): Promise<string | undefined> {
  const record = await new BrowserWorkspaceDocs().open(getBrowserWorkspaceId())
  const projected = record === null ? null : projectWorkspaceDocument(record, documentId)
  const node = projected === null ? undefined : readSpatialCanvas(projected).nodes[0]
  return node?.type === 'text' ? node.text : undefined
}

async function openPage() {
  const view = render(<BrowserDocumentPage initialPath="canvas-a" />)
  await waitFor(() => expect(screen.getByTestId('spatial-editor-container')).toBeInTheDocument(), {
    timeout: 5000,
  })
  await screen.findByRole('button', { name: 'Back to documents' }, { timeout: 5000 })
  return view
}

/**
 * Merge confirmation on the browser keeper, through the real page.
 *
 * The keeper has committed merges since the tip-adoption change, and until
 * this increment the confirmation was daemon-only chrome: the amber "not yet
 * combined" count simply stopped being drawn, with nothing saying whether the
 * merge worked, what it touched, or how to take it back. Recovery existed —
 * the pre-merge point is a saved version like any other — but only for
 * someone who knew to go looking in History for a row nobody had named.
 *
 * The merge itself is `MergeDialog`'s, and covered where it is committed. The
 * seam under test here is the one that failed: the window event the dialog
 * announces (`merge-committed-event.ts` is its declared contract) reaching a
 * toast on THIS page, and that toast's Undo landing in the browser keeper's
 * own record — no daemon, no route, no fetch.
 */
describe('BrowserDocumentPage merge confirmation (browser)', () => {
  beforeEach(async () => {
    await clearWhiteboardDb()
  })

  afterEach(() => {
    cleanup()
  })

  it('confirms a committed merge and undoes it into the record', async () => {
    const index = new FoldingBrowserIndex()
    const workspaceId = getBrowserWorkspaceId()
    await index.createWorkspace({ workspaceId })
    const { documentId } = await index.createDocument({
      workspaceId,
      path: 'canvas-a',
      kind: 'spatial',
    })
    await writeContent(documentId, 'before the merge')

    const view = await openPage()

    // The pre-merge point, saved the way a merge saves it — an ordinary
    // version row, which is exactly why Undo needs nothing a merge invented.
    await userEvent.keyboard('{Control>}s{/Control}')
    await userEvent.fill(
      await screen.findByRole('textbox', { name: 'Name this point' }),
      'before the merge',
    )
    await userEvent.keyboard('{Enter}')

    const store = new BrowserVersionStore({ docs: new BrowserWorkspaceDocs(), index })
    await waitFor(async () => expect((await store.list(workspaceId, 'canvas-a')).length).toBe(1), {
      timeout: 5000,
    })
    const preMergeVersionId = (await store.list(workspaceId, 'canvas-a'))[0]?.id
    if (preMergeVersionId === undefined) throw new Error('no pre-merge version')

    // The merge lands: content moves on behind the session, then the page is
    // reopened holding it, the way a commit leaves the document.
    view.unmount()
    await writeContent(documentId, 'after the merge')
    await openPage()
    expect(await storedText(documentId)).toBe('after the merge')

    dispatchMergeCommitted({
      workspaceId,
      path: 'canvas-a',
      sourceName: 'idea',
      targetName: 'main',
      newCount: 2,
      changedCount: 1,
      conflictCount: 0,
      preMergeVersionId,
      newElementIds: [],
      conflictElementIds: [],
    })

    // What the browser keeper had none of: the confirmation, and its counts.
    const toast = await screen.findByTestId('merge-toast', undefined, { timeout: 5000 })
    expect(toast.textContent ?? '').toContain('Combined changes from «idea»')
    expect(toast.textContent ?? '').toContain('2 added')

    await userEvent.click(screen.getByTestId('merge-toast-undo'))

    // In the record, which is the point: the browser keeper restored its own
    // saved point. A toast that still knew the daemon's route would have
    // asked a URL nothing here answers.
    await waitFor(async () => expect(await storedText(documentId)).toBe('before the merge'), {
      timeout: 5000,
    })
    await waitFor(() => expect(screen.queryByTestId('merge-toast')).toBeNull(), { timeout: 5000 })
  })
})
