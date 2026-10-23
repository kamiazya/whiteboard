import { cleanup, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { userEvent } from 'vitest/browser'
import '../index.css'
import { IdbDefaultDocumentPointer } from '../lib/browser-document-summary.js'
import { getBrowserWorkspaceId } from '../lib/browser-workspace-id.js'
import { FoldingBrowserIndex } from '../lib/folding-browser-index.js'
import { clearWhiteboardDb } from '../test-utils/browser-document.js'
import { renderPage } from '../test-utils/daemon-page-harness.js'
import { focusEditable } from '../test-utils/focus-editable.js'
import { claimIsolatedWhiteboardDb } from '../test-utils/isolated-whiteboard-db.js'
import { seedIdbDocument } from '../test-utils/seed-idb-document.js'
import { BrowserDocumentPage } from './BrowserDocumentPage.js'

claimIsolatedWhiteboardDb('browserdocumentpage-create-link')

const source = () => document.querySelector('.markdown-editor-source .cm-content')

describe('BrowserDocumentPage link create (real IndexedDB)', () => {
  beforeEach(async () => {
    await clearWhiteboardDb()
  })
  afterEach(() => {
    cleanup()
  })

  it('creates the note, rewrites the link and says so', async () => {
    const store = new FoldingBrowserIndex()
    await seedIdbDocument({ path: 'week-1', kind: 'markdown', makeDefault: true })
    renderPage(<BrowserDocumentPage store={store} />)
    await focusEditable(() =>
      document.querySelector('.markdown-editor-source [contenteditable="true"]'),
    )

    await userEvent.keyboard('See [[[[Lecture 6 notes')
    await waitFor(() => {
      const row = document.querySelector('.cm-tooltip-autocomplete li[aria-selected="true"]')
      expect(row?.textContent).toContain("Create 'Lecture 6 notes'")
    })
    await userEvent.keyboard('{Enter}')

    await waitFor(() =>
      expect(source()?.textContent).toBe('See [[lecture-6-notes|Lecture 6 notes]]'),
    )
    await waitFor(
      async () => {
        const held = await store.listDocuments({ workspaceId: getBrowserWorkspaceId() })
        const made = held.find((entry) => entry.path === 'lecture-6-notes')
        expect(made?.name).toBe('Lecture 6 notes')
      },
      { timeout: 5000 },
    )
    expect(await screen.findByText("Created 'Lecture 6 notes'")).toBeInTheDocument()
  })

  it('opens the made note with its name in the title field', async () => {
    const store = new FoldingBrowserIndex()
    await seedIdbDocument({ path: 'week-1', kind: 'markdown', makeDefault: true })
    const first = renderPage(<BrowserDocumentPage store={store} />)
    await focusEditable(() =>
      document.querySelector('.markdown-editor-source [contenteditable="true"]'),
    )
    await userEvent.keyboard('[[[[Rollback')
    await waitFor(() =>
      expect(
        document.querySelector('.cm-tooltip-autocomplete li[aria-selected="true"]')?.textContent,
      ).toContain("Create 'Rollback'"),
    )
    await userEvent.keyboard('{Enter}')
    await waitFor(() => expect(source()?.textContent).toBe('[[rollback|Rollback]]'))
    await screen.findByText("Created 'Rollback'")
    first.unmount()

    const made = (await store.listDocuments({ workspaceId: getBrowserWorkspaceId() })).find(
      (entry) => entry.path === 'rollback',
    )
    await new IdbDefaultDocumentPointer().set(made?.documentId ?? '')
    renderPage(<BrowserDocumentPage store={store} />)
    await waitFor(() => {
      const title = screen.getByRole('textbox', { name: /title/i }) as HTMLInputElement
      expect(title.value).toBe('Rollback')
    })
  })
})
