/**
 * The title box follows the name the workspace record holds, on the browser
 * keeper, without a reload. The keeper names a note after its heading inside
 * its own record, and the page used to show only the name it read at open,
 * so a note listed as "Weekly review" still read "untitled" on the page where
 * that heading was typed.
 *
 * Real IndexedDB and a real CodeMirror: the seeding happens in the keeper's
 * save path, which jsdom cannot run. The spatial editor is mocked because
 * every document here is a note.
 */
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { cleanup, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { userEvent } from 'vitest/browser'
import { listBrowserDocuments } from '../lib/browser-document-summary.js'
import { FoldingBrowserIndex } from '../lib/folding-browser-index.js'
import { IdbDocumentIndex } from '../lib/idb-document-index.js'
import { clearWhiteboardDb } from '../test-utils/browser-document.js'
import '../index.css'
import { renderPage } from '../test-utils/daemon-page-harness.js'
import { focusEditable } from '../test-utils/focus-editable.js'
import { claimIsolatedWhiteboardDb } from '../test-utils/isolated-whiteboard-db.js'
import { seedIdbDocument } from '../test-utils/seed-idb-document.js'

claimIsolatedWhiteboardDb('browserdocumentpage-name-follows')

vi.mock('../components/spatial-editor/index.js', () => ({
  SpatialEditor: (_props: { canvas: SpatialCanvas }) => <div data-testid="mock-spatial-editor" />,
}))

const { BrowserDocumentPage } = await import('./BrowserDocumentPage.js')

/** The title box as it is NOW: it remounts with the page, so never hold one. */
const titleValue = () => (screen.getByRole('textbox', { name: /title/i }) as HTMLInputElement).value

const markdownRow = async () =>
  (await listBrowserDocuments(new FoldingBrowserIndex())).find((r) => r.kind === 'markdown')

async function typeIntoBody(text: string): Promise<void> {
  const resolveEditable = () => document.querySelector('[contenteditable="true"]')
  await waitFor(() => expect(resolveEditable()).not.toBeNull(), { timeout: 10_000 })
  await focusEditable(resolveEditable)
  await userEvent.keyboard(text)
}

describe('BrowserDocumentPage title follows the record', () => {
  beforeEach(async () => {
    await clearWhiteboardDb()
  })

  afterEach(() => {
    cleanup()
  })

  it('shows the name a typed heading gives a fresh note', async () => {
    await seedIdbDocument(new IdbDocumentIndex(), {
      path: 'untitled',
      kind: 'markdown',
      makeDefault: true,
    })
    // The index production renames through: the workspace record's own.
    renderPage(<BrowserDocumentPage store={new FoldingBrowserIndex()} />)

    await typeIntoBody('# Weekly review')

    await waitFor(() => expect(titleValue()).toBe('Weekly review'), { timeout: 10_000 })
  })

  it('keeps a name chosen in the title box over a later heading', async () => {
    await seedIdbDocument(new IdbDocumentIndex(), {
      path: 'untitled',
      kind: 'markdown',
      makeDefault: true,
    })
    // The index production renames through: the workspace record's own.
    renderPage(<BrowserDocumentPage store={new FoldingBrowserIndex()} />)

    await typeIntoBody('# Draft')
    await waitFor(() => expect(titleValue()).toBe('Draft'), { timeout: 10_000 })

    const title = screen.getByRole('textbox', { name: /title/i })
    await userEvent.click(title)
    await userEvent.fill(title, 'Meeting')
    await userEvent.keyboard('{Enter}')
    await waitFor(async () => expect((await markdownRow())?.name).toBe('Meeting'), {
      timeout: 10_000,
    })

    const before = (await markdownRow())?.updatedAt
    await typeIntoBody(' notes')
    // A landed content write is what makes the absence below a decision.
    await waitFor(async () => expect((await markdownRow())?.updatedAt).not.toBe(before), {
      timeout: 10_000,
    })
    expect((await markdownRow())?.name).toBe('Meeting')
    expect(titleValue()).toBe('Meeting')
  })
})
