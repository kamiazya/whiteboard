/**
 * A browser workspace whose documents predate the workspace tree is refused
 * by name on the document page: no editor (whose first save would write over
 * a workspace it cannot read), no `Start fresh` (whose create the same
 * refusal answers), and the sentence that says why and what to do.
 */
import 'fake-indexeddb/auto'
import { generateDocumentId } from '@kamiazya/whiteboard-model'
import { cleanup, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BrowserDocumentIndex } from '../lib/browser-document-index.js'
import { BrowserStorageRefusedError } from '../lib/browser-storage-refusal.js'
import { getBrowserWorkspaceId } from '../lib/browser-workspace-id.js'
import { clearWhiteboardDb, registerTestWorkspace } from '../test-utils/browser-document.js'
import { renderPage } from '../test-utils/daemon-page-harness.js'
import { claimIsolatedWhiteboardDb } from '../test-utils/isolated-whiteboard-db.js'
import { seedLegacyRow } from '../test-utils/seed-legacy-row.js'
import { seedPreTreeContentRow } from '../test-utils/seed-retired-sync-row.js'
import { BrowserDocumentPage } from './BrowserDocumentPage.js'

claimIsolatedWhiteboardDb('browserdocumentpage-storage-refused')

vi.mock('../components/spatial-editor/index.js', () => ({
  // A marker rather than null, so "the editor did not render" is assertable.
  SpatialEditor: () => <div data-testid="mock-spatial-editor" />,
}))

const MESSAGE = new BrowserStorageRefusedError('pre-tree-records').message

describe('a workspace whose documents predate the tree', () => {
  beforeEach(async () => {
    await clearWhiteboardDb()
    await registerTestWorkspace()
    await seedLegacyRow({ workspaceId: getBrowserWorkspaceId(), path: 'old', kind: 'spatial' })
  })
  afterEach(cleanup)

  it.each([
    ['the default document', undefined],
    ['a deep link', 'old'],
  ])('refuses %s by name, with no editor and nothing to start fresh', async (_, initialPath) => {
    renderPage(
      <BrowserDocumentPage
        store={new BrowserDocumentIndex()}
        {...(initialPath === undefined ? {} : { initialPath })}
      />,
    )

    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain(MESSAGE))
    expect(screen.queryByTestId('mock-spatial-editor')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Start fresh' })).toBeNull()
  })
})

describe('a workspace holding a per-document content record', () => {
  beforeEach(async () => {
    await clearWhiteboardDb()
    await registerTestWorkspace()
    await seedPreTreeContentRow(generateDocumentId())
  })
  afterEach(cleanup)

  it('refuses it by name, with no editor and nothing to start fresh', async () => {
    renderPage(<BrowserDocumentPage store={new BrowserDocumentIndex()} />)

    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain(MESSAGE))
    expect(screen.queryByTestId('mock-spatial-editor')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Start fresh' })).toBeNull()
  })
})
