/**
 * The markdown editor's in-place projection, WIRED (ADR-0026 decision 5):
 * a text-anchored thread stored in the document reaches the source pane as
 * a highlight and a gutter marker, the marker opens the rail on that
 * conversation, and a press on a rail row is the same open state seen from
 * the other side. The component tests prove each half; this proves the
 * page holds one answer for both.
 */
import { writeCommentThread, writeMarkdownBody } from '@kamiazya/whiteboard-loro-adapter'
import { cleanup, render as rtlRender } from '@testing-library/react'
import { LoroDoc } from 'loro-crdt'
import type { ReactElement } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, expect, it, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import type { DocumentSnapshot } from '../lib/whiteboard-client.js'
import { LocalStoreDouble } from '../test-utils/local-index.js'
import '../index.css'

vi.mock('../components/spatial-editor/index.js', () => ({
  SpatialEditor: () => <div data-testid="mock-spatial-editor" />,
}))

const { BrowserDocumentPage } = await import('./BrowserDocumentPage.js')

function render(ui: ReactElement) {
  return rtlRender(
    <div style={{ height: '100vh' }}>
      <MemoryRouter initialEntries={['/']}>{ui}</MemoryRouter>
    </div>,
  )
}

const note: DocumentSnapshot = {
  documentId: '0W16BGNTZ49EKRX27CHPV05AFP',
  workspaceId: 'local',
  path: 'notes/plan',
  name: 'Plan',
  updatedAt: '2026-09-04T00:00:00.000Z',
  kind: 'markdown' as const,
}

const BODY = 'Ship the annotation layer in three steps.'

function noteWithThread(): Uint8Array {
  const doc = new LoroDoc()
  writeMarkdownBody(doc, BODY)
  const at = BODY.indexOf('three steps')
  writeCommentThread(doc, {
    id: 't-here',
    anchor: {
      kind: 'text',
      quote: { exact: 'three steps' },
      start: at,
      end: at + 'three steps'.length,
    },
    status: 'open',
    messages: [{ id: 'm1', body: 'is three still right?' }],
  })
  return doc.export({ mode: 'snapshot' })
}

afterEach(async () => {
  cleanup()
  await page.viewport(800, 600)
})

async function mountNote() {
  const store = new LocalStoreDouble()
  await store.setDefaultDocumentId(note.documentId)
  await store.save(note)
  await store.loro.save(note.documentId, noteWithThread())
  render(
    <BrowserDocumentPage
      store={store.index}
      pointer={store.pointer}
      clock={store.clock}
      loro={store.loro}
    />,
  )
}

it('the stored thread reaches the source as a highlight, and its marker opens the rail on it', async () => {
  await mountNote()
  await vi.waitFor(() =>
    expect(document.querySelector('.cm-comment-anchor')?.textContent).toBe('three steps'),
  )
  expect(document.querySelector('[data-testid="comments-panel"]')).toBeNull()

  await userEvent.click(page.getByTestId('comment-gutter-marker'))

  await expect.element(page.getByTestId('comments-panel')).toBeInTheDocument()
  const row = page.getByRole('button', { name: /is three still right/ })
  await expect.element(row).toBeInTheDocument()
  expect(row.element().getAttribute('aria-expanded')).toBe('true')
  // Opened means answerable: the reply box is already there.
  await expect.element(page.getByLabelText('Reply')).toBeInTheDocument()
  expect(document.querySelector('.cm-comment-anchor-selected')?.textContent).toBe('three steps')
})

it('on a phone the rail is a sheet over the note, and the marker still opens it', async () => {
  await page.viewport(412, 800)
  await mountNote()
  await vi.waitFor(() => expect(document.querySelector('.cm-comment-anchor')).not.toBeNull())

  await userEvent.click(page.getByTestId('comment-gutter-marker'))

  const rail = page.getByTestId('comments-rail')
  await expect.element(rail).toBeInTheDocument()
  expect(getComputedStyle(rail.element()).position).toBe('absolute')
  await page.screenshot({ path: '../../../../tmp/screenshots/phone-10-markdown-rail-sheet.png' })
})
