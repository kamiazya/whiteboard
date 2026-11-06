/**
 * A document whose stored content is in a shape no reader serves must SAY so.
 *
 * The sync session classifies it (`retired-stored-shape`, loro-adapter's
 * `RetiredStoredShapeError`) and the backend forwards the classification.
 * What this file pins is the last leg: that it reaches the screen, with no
 * editor behind it, because an editor over a refused document would save
 * over bytes that are intact.
 */
import 'fake-indexeddb/auto'
import { cleanup, screen, waitFor } from '@testing-library/react'
import { LoroDoc } from 'loro-crdt'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BrowserDocumentIndex } from '../lib/browser-document-index.js'
import { clearWhiteboardDb, registerTestWorkspace } from '../test-utils/browser-document.js'
import { renderPage } from '../test-utils/daemon-page-harness.js'
import { claimIsolatedWhiteboardDb } from '../test-utils/isolated-whiteboard-db.js'
import { seedIdbDocument } from '../test-utils/seed-idb-document.js'
import { seedTreeContent } from '../test-utils/seed-workspace-content.js'
import { BrowserDocumentPage } from './BrowserDocumentPage.js'

claimIsolatedWhiteboardDb('browserdocumentpage-retired-shape')

vi.mock('../components/spatial-editor/index.js', () => ({
  // A marker rather than null: "the editor did not render" is the guarantee
  // this file exists for, and a null mock makes it unassertable.
  SpatialEditor: () => <div data-testid="mock-spatial-editor" />,
}))

describe('a document in a retired stored shape', () => {
  beforeEach(async () => {
    await clearWhiteboardDb()
    await registerTestWorkspace()
  })
  afterEach(cleanup)

  it('says the content is in a retired shape rather than opening without it', async () => {
    // A node an older version stored in the node-kind union before ADR-0038,
    // which no reader serves: opened as usual, the `.strict()` model would
    // drop it and the board would show without it.
    const documentId = await seedIdbDocument({
      path: 'old-board',
      name: 'Old board',
      makeDefault: true,
    })
    const legacy = new LoroDoc()
    legacy
      .getMap('nodes')
      .set('old', { id: 'old', type: 'text', text: 'hi', x: 0, y: 0, width: 1, height: 1 })
    legacy.commit()
    await seedTreeContent(documentId, legacy.export({ mode: 'snapshot' }))

    renderPage(<BrowserDocumentPage store={new BrowserDocumentIndex()} />)

    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toMatch(/form this version no longer reads/i)
    })
    expect(screen.queryByTestId('mock-spatial-editor')).toBeNull()
  })
})
