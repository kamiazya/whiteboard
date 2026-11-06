/**
 * A browser workspace whose documents predate the workspace tree is refused
 * by name on the list page, never shown as an empty workspace: an empty
 * gallery over a database full of documents tells their owner the work is
 * gone.
 */

import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BrowserDocumentIndex } from '../lib/browser-document-index.js'
import { BrowserStorageRefusedError } from '../lib/browser-storage-refusal.js'
import { getBrowserWorkspaceId } from '../lib/browser-workspace-id.js'
import { clearWhiteboardDb } from '../test-utils/browser-document.js'
import { claimIsolatedWhiteboardDb } from '../test-utils/isolated-whiteboard-db.js'
import { seedLegacyRow } from '../test-utils/seed-legacy-row.js'
import { BrowserIndexPage } from './BrowserIndexPage.js'

claimIsolatedWhiteboardDb('browserindexpage-storage-refused')

describe('list page over a workspace that predates the tree', () => {
  beforeEach(clearWhiteboardDb)
  afterEach(cleanup)

  it('says why the documents cannot be opened instead of offering onboarding', async () => {
    await seedLegacyRow({ workspaceId: getBrowserWorkspaceId(), path: 'old', kind: 'spatial' })
    render(
      <MemoryRouter initialEntries={['/']}>
        <BrowserIndexPage index={new BrowserDocumentIndex()} onOpenDocument={() => {}} />
      </MemoryRouter>,
    )
    const message = new BrowserStorageRefusedError('pre-tree-records').message
    expect(await screen.findByText(message, undefined, { timeout: 10_000 })).toBeTruthy()
    expect(screen.queryByText('What will you make first?')).toBeNull()
  })
})
