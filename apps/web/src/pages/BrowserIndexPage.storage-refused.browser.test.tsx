/**
 * Browser storage this build does not read — a workspace whose documents
 * predate the workspace tree, or a database older than the one baseline — is
 * refused by name on the list page, never shown as an empty workspace: an
 * empty gallery over a database full of documents tells its owner the work is
 * gone.
 */

import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BrowserDocumentIndex } from '../lib/browser-document-index.js'
import { DB_VERSION } from '../lib/browser-idb.js'
import { BrowserStorageRefusedError } from '../lib/browser-storage-refusal.js'
import { getBrowserWorkspaceId } from '../lib/browser-workspace-id.js'
import { clearWhiteboardDb } from '../test-utils/browser-document.js'
import { claimIsolatedWhiteboardDb } from '../test-utils/isolated-whiteboard-db.js'
import { seedLegacyRow } from '../test-utils/seed-legacy-row.js'
import { BrowserIndexPage } from './BrowserIndexPage.js'

const DB = claimIsolatedWhiteboardDb('browserindexpage-storage-refused')

/** A database an older build left at `version`, holding nothing this build reads. */
async function seedOlderDatabase(version: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.open(DB, version)
    req.onupgradeneeded = () => req.result.createObjectStore('workspaces')
    req.onsuccess = () => {
      req.result.close()
      resolve()
    }
    req.onerror = () => reject(req.error)
  })
}

describe('list page over storage this build does not read', () => {
  beforeEach(clearWhiteboardDb)
  afterEach(cleanup)

  it('says why a pre-tree workspace cannot be opened instead of offering onboarding', async () => {
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

  it('says why a database older than the baseline cannot be opened', async () => {
    await seedOlderDatabase(DB_VERSION - 1)
    render(
      <MemoryRouter initialEntries={['/']}>
        <BrowserIndexPage index={new BrowserDocumentIndex()} onOpenDocument={() => {}} />
      </MemoryRouter>,
    )
    const message = new BrowserStorageRefusedError('database-version').message
    expect(await screen.findByText(message, undefined, { timeout: 10_000 })).toBeTruthy()
    expect(screen.queryByText('What will you make first?')).toBeNull()
  })
})
