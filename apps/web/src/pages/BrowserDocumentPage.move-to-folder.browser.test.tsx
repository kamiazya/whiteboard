/**
 * Filing the open document without leaving it: its More actions menu offers
 * "Move to folder…", the same picker the documents list opens, and the page
 * follows the document to its new address.
 */
import { cleanup, screen, waitFor, within } from '@testing-library/react'
import { useLocation } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { userEvent } from 'vitest/browser'
import { BrowserDocumentIndex } from '../lib/browser-document-index.js'
import { createBrowserFilesSource } from '../lib/browser-files-source.js'
import { getBrowserWorkspaceId } from '../lib/browser-workspace-id.js'
import { BrowserDocumentPage } from './BrowserDocumentPage.js'
import '../index.css'
import { clearWhiteboardDb } from '../test-utils/browser-document.js'
import { renderPage } from '../test-utils/daemon-page-harness.js'
import { claimIsolatedWhiteboardDb } from '../test-utils/isolated-whiteboard-db.js'

claimIsolatedWhiteboardDb('browserdocumentpage-move-to-folder')

function AddressProbe() {
  return <output data-testid="address">{useLocation().pathname}</output>
}

const address = () => screen.getByTestId('address').textContent ?? ''

describe('BrowserDocumentPage Move to folder (real IndexedDB)', () => {
  beforeEach(async () => {
    await clearWhiteboardDb()
  })
  afterEach(() => {
    cleanup()
  })

  it('moves the open document into a folder from its menu and follows it', async () => {
    const store = new BrowserDocumentIndex()
    renderPage(
      <>
        <AddressProbe />
        <BrowserDocumentPage store={store} />
      </>,
    )
    await waitFor(() => expect(address()).toMatch(/\/d\/untitled$/), { timeout: 5000 })
    // A folder exists once something is in it.
    await createBrowserFilesSource({ index: store }).createDocument('unit/plan', 'markdown')

    await userEvent.click(screen.getByRole('button', { name: 'More actions' }))
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Move to folder…' }))
    const dialog = await screen.findByRole('dialog', { name: 'Move to folder' })
    await userEvent.click(await within(dialog).findByRole('option', { name: 'unit' }))

    await waitFor(() => expect(address()).toMatch(/\/d\/unit\/untitled$/), { timeout: 5000 })
    const held = await store.listDocuments({ workspaceId: getBrowserWorkspaceId() })
    expect(held.map((entry) => entry.path).sort()).toEqual(['unit/plan', 'unit/untitled'])
    expect(screen.getByTestId('spatial-editor-container')).toBeInTheDocument()
  })
})
