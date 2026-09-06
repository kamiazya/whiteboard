import { writeBranchesToRecord } from '@kamiazya/whiteboard-history'
import {
  writeSpatialCanvas,
  writeWorkspaceDocumentContent,
} from '@kamiazya/whiteboard-loro-adapter'
import { cleanup, render as rtlRender, screen } from '@testing-library/react'
import { LoroDoc } from 'loro-crdt'
import type { ReactElement } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BrowserWorkspaceDocs } from '../lib/browser-workspace-docs.js'
import { getBrowserWorkspaceId } from '../lib/browser-workspace-id.js'
import { FoldingBrowserIndex } from '../lib/folding-browser-index.js'
import { clearWhiteboardDb } from '../test-utils/browser-document.js'
import { claimIsolatedWhiteboardDb } from '../test-utils/isolated-whiteboard-db.js'
import { BrowserDocumentPage } from './BrowserDocumentPage.js'
import '../index.css'

claimIsolatedWhiteboardDb('browserdocumentpagevariationpreview')

function renderAt(entry: string, ui: ReactElement) {
  return rtlRender(
    <div style={{ height: '100vh' }}>
      <MemoryRouter initialEntries={[entry]}>{ui}</MemoryRouter>
    </div>,
  )
}

/**
 * ADR-0022's `?v=` — looking at a variation WITHOUT switching onto it.
 * The daemon page has had it since the addressing decision; the browser page
 * never supplied the handler, so a browser-kept variation could be switched
 * and combined but not linked to. The mechanism reads the branches seam and
 * the address, neither of which is a keeper's business, so it belongs to the
 * page both keepers render through.
 */
describe('BrowserDocumentPage variation preview (browser)', () => {
  beforeEach(async () => {
    await clearWhiteboardDb()
  })
  afterEach(() => cleanup())

  it('opens a named variation read-only from the address, without moving HEAD', async () => {
    const workspaceId = getBrowserWorkspaceId()
    const index = new FoldingBrowserIndex()
    await index.createWorkspace({ workspaceId })
    const { documentId } = await index.createDocument({
      workspaceId,
      path: 'canvas-a',
      kind: 'spatial',
    })

    const docs = new BrowserWorkspaceDocs()
    const record = await docs.open(workspaceId)
    if (record === null) throw new Error('no record')
    const content = new LoroDoc()
    writeSpatialCanvas(content, {
      nodes: [{ id: 'n1', type: 'text', x: 0, y: 0, width: 80, height: 40, text: 'live' }],
      edges: [],
    })
    content.commit()
    writeWorkspaceDocumentContent(record, documentId, content)
    // A real frontier, so `idea` has a tip that can be checked out.
    writeBranchesToRecord(record, documentId, {
      branches: [
        { name: 'main', tipFrontiers: '', color: '#1971c2', createdAt: '2026-01-01T00:00:00.000Z' },
        {
          name: 'idea',
          tipFrontiers: '',
          color: '#9333ea',
          createdAt: '2026-01-02T00:00:00.000Z',
        },
      ],
      head: 'main',
    })
    await docs.save(workspaceId, record)

    renderAt('/?v=idea', <BrowserDocumentPage initialPath="canvas-a" />)

    // The banner that says you are LOOKING at a variation rather than on it.
    // Its sentence is split across elements (the name is its own <strong>),
    // so the banner itself identifies it and its text carries the name.
    const banner = await screen.findByTestId('variation-preview-banner', undefined, {
      timeout: 5000,
    })
    expect(banner.textContent ?? '').toMatch(/idea/i)
    // And HEAD has not moved: the chip still names the variation you are on.
    expect(screen.getByTestId('header-branch-chip').textContent ?? '').toMatch(/main/i)
  })
})
