import {
  projectWorkspaceDocument,
  readSpatialCanvas,
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

const ISOLATED_DB = claimIsolatedWhiteboardDb('browserdocumentpageversions')

function render(ui: ReactElement) {
  return rtlRender(
    <div style={{ height: '100vh' }}>
      <MemoryRouter initialEntries={['/']}>{ui}</MemoryRouter>
    </div>,
  )
}

function clearDb(): Promise<void> {
  return new Promise((resolve) => {
    const req = indexedDB.deleteDatabase(ISOLATED_DB)
    req.onsuccess = () => resolve()
    req.onerror = () => resolve()
  })
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
  // The save shortcut lives in the lazily loaded top bar; its back control
  // is the sign the chunk has mounted.
  await screen.findByRole('button', { name: 'Back to documents' }, { timeout: 5000 })
  return view
}

// The browser keeper's version history, end to end through the real page:
// the top bar's quick save writes a row, the History panel lists it, and a
// restore from the panel puts the saved state back into the record.
describe('BrowserDocumentPage version history (browser)', () => {
  beforeEach(async () => {
    await clearDb()
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
    await userEvent.click(screen.getByRole('button', { name: 'Version history' }))
    const panel = await screen.findByTestId('history-version-panel')
    // The browser's own empty-state copy: no auto-save to wait for.
    const empty = await within(panel).findByText(/No versions yet/)
    expect(empty.textContent).toContain('Press ⌘/Ctrl+S to save a version.')

    await userEvent.keyboard('{Control>}s{/Control}')

    // The row reaches the store the panel reads…
    const store = new BrowserVersionStore({ docs: new BrowserWorkspaceDocs(), index })
    await waitFor(async () => expect((await store.list(workspaceId, 'canvas-a')).length).toBe(1), {
      timeout: 5000,
    })
    // …and the open panel shows it without being reopened.
    await waitFor(() => expect(within(panel).getAllByTestId('version-row')).toHaveLength(1), {
      timeout: 5000,
    })
    expect(within(panel).getByText('Manual')).toBeInTheDocument()
    // No auto-save promise in the browser's empty-state copy path either:
    // one manual row, and the row says who saved it.
    expect(within(panel).getByText(/Human/)).toBeInTheDocument()

    // The document moves on — behind the session's back, then reopened, so
    // the page under test holds the later state the way a reload would.
    view.unmount()
    await writeContent(documentId, 'second')
    expect(await storedText(documentId)).toBe('second')
    await openPage()

    await userEvent.click(screen.getByRole('button', { name: 'Version history' }))
    const reopened = await screen.findByTestId('history-version-panel')
    await waitFor(() => expect(within(reopened).getAllByTestId('version-row')).toHaveLength(1))
    const row = within(reopened).getAllByTestId('version-row')[0]
    const restoreTarget = row?.querySelector('button')
    if (!restoreTarget) throw new Error('the version row is not restorable')
    await userEvent.click(restoreTarget)
    await userEvent.click(await screen.findByRole('button', { name: 'Restore' }))

    await waitFor(async () => expect(await storedText(documentId)).toBe('first'), {
      timeout: 5000,
    })
  })
})
