/**
 * ADR-0044 on the browser keeper's list page, over the PRODUCTION index
 * composition and real IndexedDB: the promotion band is shown as a state the
 * person can see, and at the limit adding a document is refused with the
 * reason and where to move the workspace — while what is there stays listed.
 */
import { cleanup, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { userEvent } from 'vitest/browser'
import '../index.css'
import { getBrowserWorkspaceId } from '../lib/browser-workspace-id.js'
import { FoldingBrowserIndex } from '../lib/folding-browser-index.js'
import { clearWhiteboardDb } from '../test-utils/browser-document.js'
import { claimIsolatedWhiteboardDb } from '../test-utils/isolated-whiteboard-db.js'
import { BrowserIndexPage } from './BrowserIndexPage.js'

claimIsolatedWhiteboardDb('browserindexpage-capacity')

beforeEach(async () => {
  await clearWhiteboardDb()
})
afterEach(cleanup)

async function pageHolding(paths: string[], capacity: { bandStartsAt: number; limit: number }) {
  const index = new FoldingBrowserIndex(undefined, { capacity })
  const workspaceId = getBrowserWorkspaceId()
  await index.createWorkspace({ workspaceId, segment: 'default' })
  for (const path of paths) await index.createDocument({ workspaceId, path, kind: 'markdown' })
  render(
    <MemoryRouter initialEntries={['/']}>
      <BrowserIndexPage index={index} capacity={capacity} onOpenDocument={vi.fn()} />
    </MemoryRouter>,
    { container: document.body },
  )
}

describe('browser keeper capacity on the list page', () => {
  it('shows nothing while the workspace has room', async () => {
    await pageHolding(['a'], { bandStartsAt: 3, limit: 5 })
    await screen.findAllByTestId('card-title')
    expect(screen.queryByText(/this browser can keep/i)).toBeNull()
  })

  it('in the band, offers the move before adding is refused', async () => {
    await pageHolding(['a', 'b'], { bandStartsAt: 2, limit: 5 })
    const notice = await screen.findByText(/this browser can keep up to 5/i)
    expect(within(notice).getByRole('link', { name: /move this workspace/i })).toBeTruthy()
  })

  it('at the limit, refuses a new document and says why and where to move it', async () => {
    await pageHolding(['a', 'b'], { bandStartsAt: 1, limit: 2 })
    await screen.findByText(/cannot add more here/i)

    await userEvent.click(screen.getByRole('button', { name: 'New document' }))
    await userEvent.click(await screen.findByTestId('new-document-markdown'))

    const refusal = await screen.findByRole('alert')
    expect(refusal.textContent).toMatch(/as many as this browser can keep/)
    expect(refusal.textContent).toMatch(/Settings > Connections/)
    expect(screen.getAllByTestId('card-title')).toHaveLength(2)
  })
})
