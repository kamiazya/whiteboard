import {
  documentContainers,
  projectWorkspaceDocument,
  readSpatialCanvas,
  writeCommentThread,
  writeSpatialCanvas,
  writeWorkspaceDocumentContent,
} from '@kamiazya/whiteboard-loro-adapter'
import { cleanup, render as rtlRender, screen, waitFor, within } from '@testing-library/react'
import { LoroDoc } from 'loro-crdt'
import type { ReactElement } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { userEvent } from 'vitest/browser'
import { BrowserVersionStore } from '../lib/browser-version-store.js'
import { BrowserWorkspaceDocs } from '../lib/browser-workspace-docs.js'
import { getBrowserWorkspaceId } from '../lib/browser-workspace-id.js'
import { FoldingBrowserIndex } from '../lib/folding-browser-index.js'
import { claimIsolatedWhiteboardDb } from '../test-utils/isolated-whiteboard-db.js'
import { BrowserDocumentPage } from './BrowserDocumentPage.js'
import '../index.css'
import { clearWhiteboardDb } from '../test-utils/browser-document.js'

// The claim seeds the db-name seam every opener in this page resolves;
// nothing here needs the name itself now that clearWhiteboardDb reads it.
claimIsolatedWhiteboardDb('browserdocumentpageversions')

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

/** One open conversation on the document, so the rail below is not empty. */
async function seedThread(documentId: string): Promise<void> {
  const docs = new BrowserWorkspaceDocs()
  const record = await docs.open(getBrowserWorkspaceId())
  if (record === null) throw new Error('no record')
  writeCommentThread(documentContainers(record, documentId), {
    id: 't-open',
    anchor: { kind: 'spatial', x: 10, y: 20 },
    status: 'open',
    messages: [{ id: 'm1', body: 'still needs a decision' }],
  })
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
  // The save shortcut lives in the lazily loaded top bar; its back control
  // is the sign the chunk has mounted.
  await screen.findByRole('button', { name: 'Back to documents' }, { timeout: 5000 })
  return view
}

// The browser keeper's version history, end to end through the real page:
// the top bar's quick save writes a row, the History column lists it, and a
// restore from it puts the saved state back into the record. The entry point
// is the top bar, not the canvas dock — history belongs to the document.
describe('BrowserDocumentPage version history (browser)', () => {
  beforeEach(async () => {
    await clearWhiteboardDb()
  })

  afterEach(() => {
    cleanup()
  })

  it('saves with Ctrl+S, lists in the History panel, and restores', async () => {
    const index = new FoldingBrowserIndex()
    const workspaceId = getBrowserWorkspaceId()
    await index.createWorkspace({ workspaceId })
    const { documentId } = await index.createDocument({
      workspaceId,
      path: 'canvas-a',
      kind: 'spatial',
    })
    await writeContent(documentId, 'first')

    const view = await openPage()
    // Panel open BEFORE the save, so the row has to arrive through the
    // refresh the save announces — not through the panel's mount fetch.
    await userEvent.click(screen.getByRole('button', { name: 'History' }))
    const panel = await screen.findByTestId('history-panel')
    // The browser's own empty-state copy: no auto-save to wait for, and it
    // points at the panel's own save icon rather than at a shortcut a phone
    // does not have.
    const empty = await within(panel).findByText(/No versions yet/)
    expect(empty.textContent).toContain('Save one with the button above, or ⌘/Ctrl+S.')

    // ⌘/Ctrl+S asks for a bookmark rather than taking one: it opens the
    // history with its naming field ready. An unnamed mark would be titled
    // by its time, exactly like the checkpoint beside it.
    await userEvent.keyboard('{Control>}s{/Control}')
    const nameField = await screen.findByRole('textbox', { name: 'Name this point' })
    await userEvent.fill(nameField, 'first draft')
    await userEvent.keyboard('{Enter}')

    // The row reaches the store the panel reads…
    const store = new BrowserVersionStore({ docs: new BrowserWorkspaceDocs(), index })
    await waitFor(async () => expect((await store.list(workspaceId, 'canvas-a')).length).toBe(1), {
      timeout: 5000,
    })
    // …and the open panel shows it without being reopened.
    await waitFor(() => expect(within(panel).getAllByTestId('version-row')).toHaveLength(1), {
      timeout: 5000,
    })

    // The panel's own icon: the route a finger has, where a shortcut is
    // nothing. It draws no verb — the name is the accessible name, and what
    // the save produced is the row below it, not a word beside it.
    const bookmark = within(panel).getByRole('button', { name: 'Bookmark this point' })
    expect(bookmark.textContent).toBe('')
    await userEvent.click(bookmark)
    await userEvent.fill(
      await within(panel).findByRole('textbox', { name: 'Name this point' }),
      'second draft',
    )
    await userEvent.keyboard('{Enter}')
    // Announced for a reader who cannot see the row arrive, and only there.
    const announced = await within(panel).findByText('Bookmark saved')
    expect(announced.className).toContain('sr-only')
    await waitFor(() => expect(within(panel).getAllByTestId('version-row')).toHaveLength(2), {
      timeout: 5000,
    })
    // Both rows say who took them, once each. The three-way duplication —
    // an "Auto-save"/"Manual" title, an AI/Human/System operator line and a
    // "manual" badge, all stating the same fact — is what the row rewrite
    // removed.
    // Both are named marks, and the name is what tells them apart.
    expect(within(panel).getByText('first draft')).toBeTruthy()
    expect(within(panel).getByText('second draft')).toBeTruthy()
    expect(within(panel).queryByText(/Manual|Auto-save|System|Human/)).toBeNull()

    // The document moves on — behind the session's back, then reopened, so
    // the page under test holds the later state the way a reload would.
    view.unmount()
    await writeContent(documentId, 'second')
    await seedThread(documentId)
    expect(await storedText(documentId)).toBe('second')
    await openPage()

    // The annotation rail first, while the LIVE document is on screen.
    // Scoped to the rail: the canvas draws this same text in its own bubble,
    // so an unscoped query matches two elements and reads the wrong one.
    await userEvent.click(screen.getByRole('button', { name: /comments/i }))
    const rail = await screen.findByTestId('comments-panel')
    await userEvent.click(within(rail).getByText('still needs a decision'))
    expect(within(rail).getByRole('textbox', { name: /reply/i })).toBeTruthy()

    // History takes the one inspector slot from it: the rail leaves as the
    // column arrives, and its opener reads released. Two panels beside one
    // editor was the phone screenshot the header retune started from.
    await userEvent.click(screen.getByRole('button', { name: 'History' }))
    const reopened = await screen.findByTestId('history-panel')
    expect(screen.queryByTestId('comments-panel')).toBeNull()
    expect(screen.getByRole('button', { name: /comments/i })).toHaveAttribute(
      'aria-pressed',
      'false',
    )
    await waitFor(() => expect(within(reopened).getAllByTestId('version-row')).toHaveLength(2))
    // Newest first; the OLDER row is the one holding 'first'.
    const row = within(reopened).getAllByTestId('version-row')[1]
    const restoreTarget = row?.querySelector('button')
    if (!restoreTarget) throw new Error('the version row is not restorable')
    await userEvent.click(restoreTarget)

    // LOOK first. The document shows the state that version holds while the
    // record still holds the later one — which is the whole promise: the old
    // flow asked you to confirm a state you could not see, and applying it
    // was the only way to find out what was in it.
    const preview = await screen.findByTestId('document-preview')
    await waitFor(() => expect(preview.textContent ?? '').toContain('first'))
    expect(preview.textContent ?? '').not.toContain('second')
    expect(await storedText(documentId)).toBe('second')
    // Read-only: the editor is not on screen while a past state is.
    expect(screen.queryByTestId('spatial-editor-container')).toBeNull()

    // The rail cannot be reached from here: the column that offered the
    // preview holds the inspector slot, and the preview bar hides the rail's
    // opener. (Its read-only stance under a preview is pinned on the daemon
    // page's variation preview, where the opener stays.)
    expect(screen.queryByTestId('comments-panel')).toBeNull()

    // The controls sit on the DOCUMENT's chrome, not inside the history.
    // What changed is the document, and on a narrow screen the panel is a
    // sheet at the far edge from it — so the knowledge and the way out both
    // belong where the change is. Icon-only, per the project's whole button
    // policy; the accessible name is the only text.
    const chrome = screen.getByRole('banner')
    const restore = within(chrome).getByRole('button', { name: 'Restore this version' })
    const stop = within(chrome).getByRole('button', { name: 'Stop viewing' })
    expect(restore.textContent).toBe('')
    expect(stop.textContent).toBe('')
    // …and nowhere else: a second Restore inside the panel would be two
    // controls for one act.
    expect(within(reopened).queryByRole('button', { name: /restore/i })).toBeNull()

    await userEvent.click(restore)

    await waitFor(async () => expect(await storedText(documentId)).toBe('first'), {
      timeout: 5000,
    })
  })
  it('shows the picture the bookmark carries, without waiting for a reload', async () => {
    const index = new FoldingBrowserIndex()
    const workspaceId = getBrowserWorkspaceId()
    await index.createWorkspace({ workspaceId })
    const { documentId } = await index.createDocument({
      workspaceId,
      path: 'canvas-a',
      kind: 'spatial',
    })
    await writeContent(documentId, 'something to draw')

    await openPage()
    await userEvent.click(screen.getByRole('button', { name: 'History' }))
    const panel = await screen.findByTestId('history-panel')
    await userEvent.click(within(panel).getByRole('button', { name: 'Bookmark this point' }))
    await userEvent.fill(
      await within(panel).findByRole('textbox', { name: 'Name this point' }),
      'with a picture',
    )
    await userEvent.keyboard('{Enter}')

    // The picture is rendered and stored AFTER the row lands, so the list the
    // save refreshed says `hasThumbnail: false` — a row that draws nothing
    // until something else happens to refetch it, which for a person means
    // reloading the page. Measured by hand before this was written: the
    // bytes reach IndexedDB (8323 of them) and the row shows them only after
    // a reload.
    const img = await within(panel).findByRole(
      'img',
      { name: 'Version thumbnail' },
      {
        timeout: 10_000,
      },
    )
    await waitFor(() => expect((img as HTMLImageElement).naturalWidth).toBeGreaterThan(0), {
      timeout: 10_000,
    })
  })
})
