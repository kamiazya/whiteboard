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
 * The variation chrome is RETIRED (ADR-0029): a proposal is drawn on the
 * document a person is already looking at, so a lane to switch to and a
 * banner offering to combine it are the shape that decision rejects.
 *
 * This file used to assert the opposite — a document whose HEAD is a
 * variation with work on it showed a chip naming it and a "Combine into"
 * banner. The record is deliberately kept and inverted rather than deleted:
 * the fixture below still writes a branch plane with work on it, because a
 * DOCUMENT that still carries branches is exactly the case that must draw
 * nothing once the surface is gone.
 */
describe('BrowserDocumentPage variation chrome (browser)', () => {
  beforeEach(async () => {
    await clearWhiteboardDb()
  })
  afterEach(() => cleanup())

  it('draws no chip and no combine banner, even when the record still carries a variation', async () => {
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

    // Waited for, not queried once. Both used to arrive on the record's
    // branch plane landing, which is a fetch after the first paint — a
    // synchronous `queryBy` here passes before either had a chance to
    // render, which is a green test that has checked nothing. Measured:
    // with the surfaces still in place, the synchronous form passed and
    // this one fails.
    await expect(
      screen.findByRole('button', { name: /Combine into/i }, { timeout: 2000 }),
    ).rejects.toThrow()
    await expect(screen.findByTestId('header-branch-chip', {}, { timeout: 1000 })).rejects.toThrow()
    // And nothing names the variation anywhere in the chrome: a label left
    // behind would be a surface with no verb, which is worse than either.
    expect(document.body.textContent ?? '').not.toMatch(/idea/i)
  })
})
