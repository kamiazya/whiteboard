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
import {
  documentContainers,
  readWorkspaceDocumentName,
  setWorkspaceDocumentName,
  writeMarkdownBody,
} from '@kamiazya/whiteboard-loro-adapter'
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import type { SetDocumentNameInput } from '@kamiazya/whiteboard-ports'
import { cleanup, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { userEvent } from 'vitest/browser'
import { listBrowserDocuments } from '../lib/browser-document-summary.js'
import { BrowserWorkspaceDocs } from '../lib/browser-workspace-docs.js'
import { getBrowserWorkspaceId } from '../lib/browser-workspace-id.js'
import { FoldingBrowserIndex } from '../lib/folding-browser-index.js'
import { IdbDocumentIndex } from '../lib/idb-document-index.js'
import { announceDocumentRenamed } from '../lib/workspace-broadcast.js'
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

/** The page's index, holding each rename until the test lets it land. */
class HeldRenames extends FoldingBrowserIndex {
  readonly #release = Promise.withResolvers<void>()
  readonly #entered = Promise.withResolvers<void>()
  readonly entered = this.#entered.promise
  release(): void {
    this.#release.resolve()
  }
  override async setDocumentName(input: SetDocumentNameInput): Promise<void> {
    this.#entered.resolve()
    await this.#release.promise
    return super.setDocumentName(input)
  }
}

/**
 * Another tab's write: a name and a line of body into the stored record, then
 * the rename announced. Straight to the record rather than through an index,
 * whose reads wait on the page's held rename.
 */
async function recordElsewhere(documentId: string, name: string, body: string): Promise<void> {
  const docs = new BrowserWorkspaceDocs()
  const doc = await docs.open(getBrowserWorkspaceId())
  if (doc === null) throw new Error('the workspace record was not stored')
  setWorkspaceDocumentName(doc, { documentId, name })
  writeMarkdownBody(documentContainers(doc, documentId), body)
  doc.commit()
  await docs.save(getBrowserWorkspaceId(), doc)
  announceDocumentRenamed(getBrowserWorkspaceId(), documentId)
}

/** The name the stored record holds, read past the index. */
async function storedName(documentId: string): Promise<string | null | undefined> {
  const doc = await new BrowserWorkspaceDocs().open(getBrowserWorkspaceId())
  return doc === null ? null : readWorkspaceDocumentName(doc, documentId)
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

  // The title box reads empty for a name equal to the path, so the page's
  // heading is where an unnamed document's path shows.
  it('shows the path once the name is cleared elsewhere', async () => {
    const documentId = await seedIdbDocument(new IdbDocumentIndex(), {
      path: 'weekly',
      name: 'Weekly review',
      kind: 'markdown',
      makeDefault: true,
    })
    renderPage(<BrowserDocumentPage store={new FoldingBrowserIndex()} />)
    await waitFor(() => expect(titleValue()).toBe('Weekly review'), { timeout: 10_000 })

    // Another tab's index: the page hears of it only through the record.
    await new FoldingBrowserIndex().setDocumentName({
      workspaceId: getBrowserWorkspaceId(),
      documentId,
    })

    await waitFor(
      () => expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('weekly'),
      { timeout: 10_000 },
    )
    expect(titleValue()).toBe('')
  })

  it('keeps a rename whose save is in flight over a name recorded elsewhere', async () => {
    const documentId = await seedIdbDocument(new IdbDocumentIndex(), {
      path: 'weekly',
      name: 'Weekly review',
      kind: 'markdown',
      makeDefault: true,
    })
    const store = new HeldRenames()
    renderPage(<BrowserDocumentPage store={store} />)
    await waitFor(() => expect(titleValue()).toBe('Weekly review'), { timeout: 10_000 })
    const title = screen.getByRole('textbox', { name: /title/i })
    await userEvent.click(title)
    await userEvent.fill(title, 'Meeting')
    await userEvent.keyboard('{Enter}')
    await store.entered

    // The body line reaching this page is what says it has read that write.
    await recordElsewhere(documentId, 'Elsewhere', 'from elsewhere')
    await waitFor(
      () => expect(document.querySelector('.cm-content')?.textContent).toBe('from elsewhere'),
      { timeout: 10_000 },
    )
    // A round trip to the database first, so a title the follow would have
    // replaced has re-rendered by the time it is read.
    await expect(storedName(documentId)).resolves.toBe('Elsewhere')
    expect(titleValue()).toBe('Meeting')

    store.release()
    await waitFor(async () => expect((await markdownRow())?.name).toBe('Meeting'), {
      timeout: 10_000,
    })
    expect(titleValue()).toBe('Meeting')
  })
})
