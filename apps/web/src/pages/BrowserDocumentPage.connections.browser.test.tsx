/**
 * The Connections chip on a BROWSER-kept document, over real IndexedDB: the
 * same count and the same "open the source" the daemon page has pinned, now
 * answered from this browser's own documents.
 */
import { writeDocumentKind, writeMarkdownBody } from '@kamiazya/whiteboard-loro-adapter'
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { Loro } from 'loro-crdt'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { userEvent } from 'vitest/browser'
import '../index.css'
import { getBrowserWorkspaceId } from '../lib/browser-workspace-id.js'
import { FoldingBrowserIndex } from '../lib/folding-browser-index.js'
import { seedWorkspaceDocumentContent } from '../lib/workspace-content.js'
import { clearWhiteboardDb } from '../test-utils/browser-document.js'
import { claimIsolatedWhiteboardDb } from '../test-utils/isolated-whiteboard-db.js'

claimIsolatedWhiteboardDb('browserdocumentpage-connections')

vi.mock('../components/spatial-editor/index.js', () => ({
  SpatialEditor: (_props: { canvas: SpatialCanvas }) => <div data-testid="mock-spatial-editor" />,
}))

const { BrowserDocumentPage } = await import('./BrowserDocumentPage.js')

beforeEach(async () => {
  await clearWhiteboardDb()
})
afterEach(cleanup)

function LocationProbe() {
  return <output data-testid="location">{useLocation().pathname}</output>
}

async function note(index: FoldingBrowserIndex, path: string, name: string, body: string) {
  const entry = await index.createDocument({
    workspaceId: getBrowserWorkspaceId(),
    path,
    kind: 'markdown',
    name,
  })
  const doc = new Loro()
  writeDocumentKind(doc, 'markdown')
  writeMarkdownBody(doc, body)
  expect(
    await seedWorkspaceDocumentContent(entry.documentId, doc.export({ mode: 'snapshot' })),
  ).toBe(true)
}

it('shows the Connections chip with the backlink count and opens the source', async () => {
  const index = new FoldingBrowserIndex()
  await index.createWorkspace({ workspaceId: getBrowserWorkspaceId(), segment: 'default' })
  await note(index, 'beta', 'Beta', 'The target.')
  await note(index, 'alpha', 'Alpha', 'See [[beta]] for the details.')

  render(
    <div style={{ height: '100vh' }}>
      <MemoryRouter initialEntries={['/']}>
        <BrowserDocumentPage store={index} initialPath="beta" />
        <LocationProbe />
      </MemoryRouter>
    </div>,
  )

  const chip = await screen.findByRole(
    'button',
    { name: /connections \(1\)/i },
    { timeout: 15_000 },
  )
  await userEvent.click(chip)
  await userEvent.click(await screen.findByRole('button', { name: /alpha/i }))

  await waitFor(() => expect(screen.getByTestId('location').textContent).toMatch(/\/alpha$/), {
    timeout: 15_000,
  })
})

it('links a mention from the panel, and the source moves to the backlinks', async () => {
  const index = new FoldingBrowserIndex()
  await index.createWorkspace({ workspaceId: getBrowserWorkspaceId(), segment: 'default' })
  await note(index, 'beta', 'Beta', 'The target.')
  await note(index, 'gamma', 'Gamma', 'Beta came up in the review.')

  render(
    <div style={{ height: '100vh' }}>
      <MemoryRouter initialEntries={['/']}>
        <BrowserDocumentPage store={index} initialPath="beta" />
        <LocationProbe />
      </MemoryRouter>
    </div>,
  )

  await userEvent.click(
    await screen.findByRole('button', { name: /connections \(0\)/i }, { timeout: 15_000 }),
  )
  await userEvent.click(await screen.findByRole('button', { name: /link it/i }))

  await screen.findByRole('button', { name: /connections \(1\)/i }, { timeout: 15_000 })
  await waitFor(() => expect(screen.queryByRole('button', { name: /link it/i })).toBeNull())
})
