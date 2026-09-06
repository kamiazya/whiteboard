import { readBranchesFromRecord, writeBranchesToRecord } from '@kamiazya/whiteboard-history'
import {
  writeSpatialCanvas,
  writeWorkspaceDocumentContent,
} from '@kamiazya/whiteboard-loro-adapter'
import { cleanup, render as rtlRender, screen, waitFor } from '@testing-library/react'
import { LoroDoc } from 'loro-crdt'
import type { ReactElement } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BrowserVersionStore } from '../lib/browser-version-store.js'
import { BrowserWorkspaceDocs } from '../lib/browser-workspace-docs.js'
import { getBrowserWorkspaceId } from '../lib/browser-workspace-id.js'
import { FoldingBrowserIndex } from '../lib/folding-browser-index.js'
import { clearWhiteboardDb } from '../test-utils/browser-document.js'
import { claimIsolatedWhiteboardDb } from '../test-utils/isolated-whiteboard-db.js'
import { BrowserDocumentPage } from './BrowserDocumentPage.js'
import '../index.css'

claimIsolatedWhiteboardDb('browserdocumentpagebranchchrome')

function render(ui: ReactElement) {
  return rtlRender(
    <div style={{ height: '100vh' }}>
      <MemoryRouter initialEntries={['/']}>{ui}</MemoryRouter>
    </div>,
  )
}

/**
 * The chrome that sits BESIDE the variations chip — the "you are on a
 * variation, combine it" banner. It was mounted only by the daemon page, from
 * when variations were a daemon concept; both keepers have them now, so the
 * browser showing nothing was a gap rather than a difference.
 */
describe('BrowserDocumentPage variation chrome (browser)', () => {
  beforeEach(async () => {
    await clearWhiteboardDb()
  })
  afterEach(() => cleanup())

  it('offers to combine when HEAD is a variation with work on it', async () => {
    const workspaceId = getBrowserWorkspaceId()
    const index = new FoldingBrowserIndex()
    await index.createWorkspace({ workspaceId })
    const { documentId } = await index.createDocument({
      workspaceId,
      path: 'canvas-a',
      kind: 'spatial',
    })
    const doc = new LoroDoc()
    writeSpatialCanvas(doc, {
      nodes: [{ id: 'n1', type: 'text', x: 0, y: 0, width: 80, height: 40, text: 'first' }],
      edges: [],
    })
    doc.commit()
    const docs = new BrowserWorkspaceDocs()
    const record = await docs.open(workspaceId)
    if (record === null) throw new Error('no record')
    writeWorkspaceDocumentContent(record, documentId, doc)
    writeBranchesToRecord(record, documentId, {
      branches: [
        { name: 'main', tipFrontiers: '', color: '#1971c2', createdAt: '2026-01-01T00:00:00.000Z' },
        { name: 'idea', tipFrontiers: '', color: '#9333ea', createdAt: '2026-01-02T00:00:00.000Z' },
      ],
      head: 'idea',
    })
    await docs.save(workspaceId, record)
    // The banner needs work ON the variation — a count of zero is what it
    // reads as "nothing to combine". Saved through a store built on the SAME
    // `docs` instance: the store re-opens the record to read its frontier, and
    // a second opener would write back a record loaded before the branches
    // above and revert them.
    await new BrowserVersionStore({ docs, index }).save(workspaceId, 'canvas-a', {
      branchName: 'idea',
      label: 'a point on idea',
    })
    await vi.waitFor(async () => {
      const back = await new BrowserWorkspaceDocs().open(workspaceId)
      expect(back === null ? null : readBranchesFromRecord(back, documentId).head).toBe('idea')
    })

    render(<BrowserDocumentPage initialPath="canvas-a" />)
    await waitFor(
      () => expect(screen.getByTestId('spatial-editor-container')).toBeInTheDocument(),
      {
        timeout: 5000,
      },
    )

    // The banner names the variation, its count, and the target — the count
    // is what `getStats` answers, so this pins the whole chain: record ->
    // version rows -> stats -> banner.
    // The banner's CTA. Its own sentence is split across elements (the
    // variation names are their own spans), so the button is what identifies
    // the banner; the count behind it is asserted on `getStats` directly.
    const combine = await screen.findByRole('button', { name: /Combine into/i }, { timeout: 5000 })
    expect(combine).toBeInTheDocument()
    // And the chip beside it names the same variation. It said `Main` until
    // the record's arrival re-read the branch plane.
    expect(screen.getByTestId('header-branch-chip').textContent ?? '').toMatch(/idea/i)
  })
})
