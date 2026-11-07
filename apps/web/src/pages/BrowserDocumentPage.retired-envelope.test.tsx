/**
 * A sync envelope an older build wrote is intact data this build no longer
 * lifts. The page says so by name and offers no `Start fresh`, whose delete
 * is reserved for bytes Loro cannot import.
 */
import 'fake-indexeddb/auto'
import { cleanup, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BrowserDocumentIndex } from '../lib/browser-document-index.js'
import { getBrowserWorkspaceId } from '../lib/browser-workspace-id.js'
import { documentReadFailureMessage } from '../lib/document-read-failure.js'
import { clearWhiteboardDb, registerTestWorkspace } from '../test-utils/browser-document.js'
import { renderPage } from '../test-utils/daemon-page-harness.js'
import { claimIsolatedWhiteboardDb } from '../test-utils/isolated-whiteboard-db.js'
import { seedRetiredEnvelope } from '../test-utils/seed-retired-sync-row.js'
import { BrowserDocumentPage } from './BrowserDocumentPage.js'

claimIsolatedWhiteboardDb('browserdocumentpage-retired-envelope')

vi.mock('../components/spatial-editor/index.js', () => ({
  SpatialEditor: () => <div data-testid="mock-spatial-editor" />,
}))

describe('a workspace record in a retired envelope', () => {
  beforeEach(async () => {
    await clearWhiteboardDb()
    await registerTestWorkspace()
    await seedRetiredEnvelope(getBrowserWorkspaceId())
  })
  afterEach(cleanup)

  it('is named as saved by an older version, with no editor and nothing to start fresh', async () => {
    renderPage(<BrowserDocumentPage store={new BrowserDocumentIndex()} />)

    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toContain(
        documentReadFailureMessage('retired-stored-shape'),
      ),
    )
    expect(screen.queryByTestId('mock-spatial-editor')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Start fresh' })).toBeNull()
  })
})
