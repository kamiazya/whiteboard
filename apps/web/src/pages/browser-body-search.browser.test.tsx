import { writeDocumentKind, writeMarkdownBody } from '@kamiazya/whiteboard-loro-adapter'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { Loro } from 'loro-crdt'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BrowserDocumentIndex } from '../lib/browser-document-index.js'
import { getBrowserWorkspaceId } from '../lib/browser-workspace-id.js'
import { clearWhiteboardDb } from '../test-utils/browser-document.js'
import { claimIsolatedWhiteboardDb } from '../test-utils/isolated-whiteboard-db.js'
import { seedTreeContent, seedTreeDocument } from '../test-utils/seed-workspace-content.js'
import { BrowserIndexPage } from './BrowserIndexPage.js'

// The page, its source and the panel together — the seam the unit tests
// each covered one side of, and where the preview found nothing.

claimIsolatedWhiteboardDb('browser-body-search-page')

// A repeat reruns the body, not the file's setup: without a reset the second
// pass finds `untitled` already in the claimed database and the keeper refuses.
beforeEach(clearWhiteboardDb)
afterEach(cleanup)

describe('searching from the page', () => {
  it('finds a document by a word only its body carries', async () => {
    // Seeded as an older build left it; the page's own index folds it into
    // the workspace tree on its first read.
    const entry = await seedTreeDocument({
      workspaceId: getBrowserWorkspaceId(),
      path: 'untitled',
      kind: 'markdown',
    })
    const doc = new Loro()
    writeDocumentKind(doc, 'markdown')
    writeMarkdownBody(doc, 'A QuotaExceededError arrives on save.')
    await seedTreeContent(entry.documentId, doc.export({ mode: 'snapshot' }))

    render(
      <MemoryRouter initialEntries={['/']}>
        <BrowserIndexPage index={new BrowserDocumentIndex()} onOpenDocument={vi.fn()} />
      </MemoryRouter>,
    )
    const box = await screen.findByLabelText('Search documents', undefined, { timeout: 10_000 })
    fireEvent.change(box, { target: { value: 'QuotaExceededError' } })

    await waitFor(
      () => {
        const results = screen.getByTestId('search-results')
        expect(results.querySelector('[data-doc-path="untitled"]')).not.toBeNull()
      },
      { timeout: 10_000 },
    )
  })
})
