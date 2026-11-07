// ADR-0040 decision 5 and 6 on the browser keeper: the board's tag row
// completes from the whole workspace — what a note elsewhere already uses,
// and what the document at `tags` declares — and refuses what the library
// forbids. Through the page, because the page is what binds the keeper's
// files source to the rows; the row's own behaviour is pinned in
// TagChipsEditor.test.tsx.
import { writeCoreFacets, writeFacets } from '@kamiazya/whiteboard-loro-adapter'
import { cleanup, screen, waitFor } from '@testing-library/react'
import { LoroDoc } from 'loro-crdt'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { userEvent } from 'vitest/browser'
import { IdbDefaultDocumentPointer } from '../lib/browser-document-summary.js'
import { clearWhiteboardDb } from '../test-utils/browser-document.js'
import { claimIsolatedWhiteboardDb } from '../test-utils/isolated-whiteboard-db.js'
import { seedTreeDocument } from '../test-utils/seed-workspace-content.js'
import '../index.css'
import { renderPage } from '../test-utils/daemon-page-harness.js'
import { setViewport } from '../test-utils/viewport.js'

claimIsolatedWhiteboardDb('browserdocumentpage-tag-vocabulary')

vi.mock('../components/spatial-editor/index.js', () => ({
  SpatialEditor: () => <div data-testid="mock-spatial-editor" style={{ height: '100%' }} />,
}))

vi.mock('../lib/browser-backend.js', async () => {
  const { FakeBrowserBackend } = await import('../test-utils/fake-browser-backend.js')
  return { BrowserBackend: FakeBrowserBackend }
})

const { BrowserDocumentPage } = await import('./BrowserDocumentPage.js')

beforeEach(async () => {
  await clearWhiteboardDb()
  await setViewport(1024, 780)
})

afterEach(cleanup)

const tagBox = () => screen.getByLabelText('Add tag') as HTMLInputElement
const offered = () =>
  [...document.querySelectorAll('datalist option')].map((option) => option.getAttribute('value'))

it('the board tag row offers a note’s tag and the library’s values, and refuses what the library forbids', async () => {
  const board = await seedTreeDocument({ path: 'notes/board', name: 'Board', kind: 'spatial' })
  await new IdbDefaultDocumentPointer().set(board.documentId)
  const noteDoc = new LoroDoc()
  writeCoreFacets(noteDoc, { type: 'note', tags: ['ops'] })
  await seedTreeDocument({
    path: 'notes/ops',
    name: 'Ops',
    kind: 'markdown',
    content: noteDoc.export({ mode: 'snapshot' }),
  })
  const libraryDoc = new LoroDoc()
  writeFacets(libraryDoc, {
    'visual.tags/v0': { keys: { health: { exclusive: true, values: { ok: {}, failing: {} } } } },
  } as never)
  await seedTreeDocument({
    path: 'tags',
    name: 'Tags',
    kind: 'markdown',
    content: libraryDoc.export({ mode: 'snapshot' }),
  })

  renderPage(<BrowserDocumentPage />)
  await screen.findByTestId('mock-spatial-editor', undefined, { timeout: 15_000 })
  await userEvent.click(await screen.findByRole('button', { name: /^display$/i }))
  await screen.findByTestId('display-panel', undefined, { timeout: 15_000 })

  // The vocabulary arrives after a read; wait for the note's tag to be offered.
  await userEvent.type(tagBox(), 'o')
  await waitFor(() => expect(offered()).toContain('ops'), { timeout: 15_000 })
  await userEvent.clear(tagBox())
  await userEvent.type(tagBox(), 'health:')
  await waitFor(() => expect(offered()).toEqual(['health:failing', 'health:ok']))

  await userEvent.clear(tagBox())
  await userEvent.type(tagBox(), 'health:unknown{Enter}')
  expect((await screen.findByRole('alert')).textContent).toMatch(/health admits failing, ok/)
})
