import { writeDocumentKind, writeMarkdownBody } from '@kamiazya/whiteboard-loro-adapter'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { Loro } from 'loro-crdt'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getBrowserWorkspaceId } from '../lib/browser-workspace-id.js'
import { IdbDocumentIndex } from '../lib/idb-document-index.js'
import { ensureLocalWorkspace } from '../lib/local-document-summary.js'
import { LoroStore } from '../lib/loro-store.js'
import { claimIsolatedWhiteboardDb } from '../test-utils/isolated-whiteboard-db.js'
import { BrowserIndexPage } from './BrowserIndexPage.js'

// The page, its source and the panel together — the seam the unit tests
// each covered one side of, and where the preview found nothing.

claimIsolatedWhiteboardDb('local-body-search-page')

afterEach(cleanup)

describe('searching from the page', () => {
  it('finds a document by a word only its body carries', async () => {
    const index = new IdbDocumentIndex()
    await ensureLocalWorkspace(index)
    const entry = await index.createDocument({
      workspaceId: getBrowserWorkspaceId(),
      path: 'untitled',
      kind: 'markdown',
    })
    const doc = new Loro()
    writeDocumentKind(doc, 'markdown')
    writeMarkdownBody(doc, 'A QuotaExceededError arrives on save.')
    await new LoroStore().save(entry.documentId, doc.export({ mode: 'snapshot' }))

    render(
      <MemoryRouter initialEntries={['/']}>
        <BrowserIndexPage index={index} onOpenDocument={vi.fn()} />
      </MemoryRouter>,
    )
    const box = await screen.findByLabelText('Search documents', undefined, { timeout: 10_000 })
    fireEvent.change(box, { target: { value: 'QuotaExceededError' } })

    await waitFor(
      () => {
        expect(screen.getByTestId('search-results').textContent).toContain('untitled')
      },
      { timeout: 10_000 },
    )
  })
})
