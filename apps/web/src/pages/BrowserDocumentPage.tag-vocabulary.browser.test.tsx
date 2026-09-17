// ADR-0040 decision 5 and 6 on the browser keeper: the board's tag row
// completes from the whole workspace — what a note elsewhere already uses,
// and what the document at `tags` declares — and refuses what the library
// forbids. Through the page, because the page is what binds the keeper's
// files source to the rows; the row's own behaviour is pinned in
// TagChipsEditor.test.tsx.
import { writeCoreFacets, writeFacets } from '@kamiazya/whiteboard-loro-adapter'
import { cleanup, render as rtlRender, screen, waitFor } from '@testing-library/react'
import { LoroDoc } from 'loro-crdt'
import type { ReactElement } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { userEvent } from 'vitest/browser'
import type { DocumentSnapshot } from '../lib/whiteboard-client.js'
import { LocalStoreDouble } from '../test-utils/local-index.js'
import '../index.css'
import { setViewport } from '../test-utils/viewport.js'

vi.mock('../components/spatial-editor/index.js', () => ({
  SpatialEditor: () => <div data-testid="mock-spatial-editor" style={{ height: '100%' }} />,
}))

vi.mock('../lib/browser-backend.js', async () => {
  const { FakeBrowserBackend } = await import('../test-utils/fake-browser-backend.js')
  return { BrowserBackend: FakeBrowserBackend }
})

const { BrowserDocumentPage } = await import('./BrowserDocumentPage.js')

function render(ui: ReactElement) {
  return rtlRender(
    <div style={{ height: '100vh' }}>
      <MemoryRouter initialEntries={['/']}>{ui}</MemoryRouter>
    </div>,
  )
}

const board: DocumentSnapshot = {
  documentId: '0W16BGNTZ49EKRX27CHPV05AFM',
  workspaceId: 'local',
  path: 'notes/board',
  name: 'Board',
  updatedAt: '2026-09-03T00:00:00.000Z',
  kind: 'spatial' as const,
}
const note: DocumentSnapshot = {
  ...board,
  documentId: '0W16BGNTZ49EKRX27CHPV05AFN',
  path: 'notes/ops',
  name: 'Ops',
  kind: 'markdown' as const,
}
const library: DocumentSnapshot = {
  ...board,
  documentId: '0W16BGNTZ49EKRX27CHPV05AFP',
  path: 'tags',
  name: 'Tags',
  kind: 'markdown' as const,
}

beforeEach(async () => {
  await setViewport(1024, 780)
})

afterEach(cleanup)

const tagBox = () => screen.getByLabelText('Add tag') as HTMLInputElement
const offered = () =>
  [...document.querySelectorAll('datalist option')].map((option) => option.getAttribute('value'))

it('the board tag row offers a note’s tag and the library’s values, and refuses what the library forbids', async () => {
  const store = new LocalStoreDouble()
  await store.setDefaultDocumentId(board.documentId)
  await store.save(board)
  await store.save(note)
  const noteDoc = new LoroDoc()
  writeCoreFacets(noteDoc, { type: 'note', tags: ['ops'] })
  await store.loro.save(note.documentId, noteDoc.export({ mode: 'snapshot' }))
  await store.save(library)
  const libraryDoc = new LoroDoc()
  writeFacets(libraryDoc, {
    'visual.tags/v0': { keys: { health: { exclusive: true, values: { ok: {}, failing: {} } } } },
  } as never)
  await store.loro.save(library.documentId, libraryDoc.export({ mode: 'snapshot' }))

  render(
    <BrowserDocumentPage
      store={store.index}
      loro={store.loro}
      pointer={store.pointer}
      clock={store.clock}
    />,
  )
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
