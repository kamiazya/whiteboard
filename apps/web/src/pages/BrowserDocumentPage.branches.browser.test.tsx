import { readBranchesFromRecord } from '@kamiazya/whiteboard-history'
import {
  writeSpatialCanvas,
  writeWorkspaceDocumentContent,
} from '@kamiazya/whiteboard-loro-adapter'
import { cleanup, render as rtlRender, screen, waitFor } from '@testing-library/react'
import { LoroDoc } from 'loro-crdt'
import type { ReactElement } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { userEvent } from 'vitest/browser'
import { BrowserWorkspaceDocs } from '../lib/browser-workspace-docs.js'
import { getBrowserWorkspaceId } from '../lib/browser-workspace-id.js'
import { FoldingBrowserIndex } from '../lib/folding-browser-index.js'
import { clearWhiteboardDb } from '../test-utils/browser-document.js'
import { claimIsolatedWhiteboardDb } from '../test-utils/isolated-whiteboard-db.js'
import { BrowserDocumentPage } from './BrowserDocumentPage.js'
import '../index.css'

claimIsolatedWhiteboardDb('browserdocumentpagebranches')

function render(ui: ReactElement) {
  return rtlRender(
    <div style={{ height: '100vh' }}>
      <MemoryRouter initialEntries={['/']}>{ui}</MemoryRouter>
    </div>,
  )
}

async function seedDocument(): Promise<string> {
  const index = new FoldingBrowserIndex()
  const workspaceId = getBrowserWorkspaceId()
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
  await docs.save(workspaceId, record)
  return documentId
}

/** The branches the RECORD holds, read back the way any replica would. */
async function storedBranches(documentId: string): Promise<string[]> {
  const record = await new BrowserWorkspaceDocs().open(getBrowserWorkspaceId())
  if (record === null) return []
  return readBranchesFromRecord(record, documentId).branches.map((b) => b.name)
}

// Variations in browser mode, end to end through the real page. Until this
// increment the chip was not there at all: the keeper's branches were a
// daemon row, and a row is not something a browser has. They are a plane of
// the workspace record now, so the same header control answers.
describe('BrowserDocumentPage variations (browser)', () => {
  beforeEach(async () => {
    await clearWhiteboardDb()
  })

  afterEach(() => {
    cleanup()
  })

  it('the chip is identity: it sits with the title, left of the act menu', async () => {
    await seedDocument()
    render(<BrowserDocumentPage initialPath="canvas-a" />)
    await waitFor(
      () => expect(screen.getByTestId('spatial-editor-container')).toBeInTheDocument(),
      {
        timeout: 5000,
      },
    )
    const chip = await screen.findByRole('button', { name: /^Switch variation/ })
    const kebab = await screen.findByRole('button', { name: 'More actions' })
    const segment = screen.getByTestId('inspector-segment')

    // Reading order, taken from the row itself rather than from x
    // coordinates: what a screen reader and the tab sequence follow is the
    // DOM, and `DOCUMENT_POSITION_FOLLOWING` says one node comes after
    // another in it.
    const follows = (a: Element, b: Element) =>
      (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0

    // Which variation you are on is WHICH DOCUMENT you are looking at — the
    // same question the title answers — so it belongs beside the title, not
    // after the things that act on it. Measured before this increment at
    // 1280px: `Comments@1022, History@1056, More actions@1108, Switch
    // variation@1165`, identity pushed to the far right of the row by
    // `HeaderBranchChip` rendering after the slot the act controls moved into.
    expect(follows(chip, segment)).toBe(true)
    expect(follows(chip, kebab)).toBe(true)
  })

  it('creates a variation from the chip and keeps it on the record', async () => {
    const documentId = await seedDocument()
    render(<BrowserDocumentPage initialPath="canvas-a" />)
    await waitFor(
      () => expect(screen.getByTestId('spatial-editor-container')).toBeInTheDocument(),
      {
        timeout: 5000,
      },
    )

    // The chip itself is the first assertion: in browser mode it used to be
    // absent, replaced by a disabled "Variations" teaser.
    const chip = await screen.findByTestId('header-branch-chip', undefined, { timeout: 5000 })
    // Case-insensitive: the chip capitalises the label for display, and the
    // NAME is `main` — asserting the rendering would pin a style choice.
    expect(chip.textContent ?? '').toMatch(/main/i)

    await userEvent.click(chip)
    await userEvent.click(await screen.findByText(/New variation/))
    const input = await screen.findByPlaceholderText('New variation name')
    await userEvent.type(input, 'idea{Enter}')

    // On the record, which is the point: no row, no request, and a replica
    // importing this workspace sees the variation too.
    await waitFor(
      async () => expect((await storedBranches(documentId)).sort()).toEqual(['idea', 'main']),
      {
        timeout: 5000,
      },
    )
  })
})
