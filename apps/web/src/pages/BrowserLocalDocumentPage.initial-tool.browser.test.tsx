import { cleanup, render as rtlRender, screen, waitFor } from '@testing-library/react'
import type { ReactElement } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { userEvent } from 'vitest/browser'
import { IdbDocumentIndex } from '../lib/idb-document-index.js'
import { BrowserLocalDocumentPage } from './BrowserLocalDocumentPage.js'
import '../index.css'
import { claimIsolatedWhiteboardDb } from '../test-utils/isolated-whiteboard-db.js'

const ISOLATED_DB = claimIsolatedWhiteboardDb('browserlocaldocumentpage-initial-tool')

// Real browser + real IndexedDB: the canvas's node count comes from the Loro
// document the backend actually loads, which is exactly the input the initial
// tool is derived from — a jsdom mock would have to fake that input away.
function render(ui: ReactElement) {
  return rtlRender(
    <div style={{ height: '100vh' }}>
      <MemoryRouter initialEntries={['/']}>{ui}</MemoryRouter>
    </div>,
  )
}

async function clearDb(): Promise<void> {
  return new Promise((resolve) => {
    const req = indexedDB.deleteDatabase(ISOLATED_DB)
    req.onsuccess = () => resolve()
    req.onerror = () => resolve()
  })
}

async function mountLoaded(): Promise<void> {
  render(<BrowserLocalDocumentPage store={new IdbDocumentIndex()} />)
  await waitFor(() => expect(screen.getByTestId('spatial-editor-container')).toBeInTheDocument(), {
    timeout: 5000,
  })
}

function pressed(name: string): string | null {
  return screen.getByRole('button', { name }).getAttribute('aria-pressed')
}

beforeEach(async () => {
  // Only the key this suite is about: storages are origin-shared across
  // parallel test files, and clear() wipes the neighbours' state too.
  sessionStorage.removeItem('wb.lastTool')
  await clearDb()
})

afterEach(() => {
  cleanup()
})

describe('initial tool follows the canvas shape (real browser)', () => {
  it('opens an empty canvas in Select, and the same canvas in Hand once it holds a node', async () => {
    await mountLoaded()
    await waitFor(() => expect(pressed('Select')).toBe('true'), { timeout: 5000 })

    // Add one node through the real editor so the stored document — not a
    // fixture — is what the next mount reads. Radix menus need real pointer
    // events (trigger opens on pointerdown, items select on pointerup).
    await userEvent.click(screen.getByRole('button', { name: 'Add' }))
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Note' }))
    // The new node's inline editor opens focused; commit it by clicking away.
    await userEvent.click(screen.getByTestId('spatial-editor-container'))
    await waitFor(
      () => expect(screen.getByTestId('save-status-chip').getAttribute('aria-label')).toBe('Saved'),
      {
        timeout: 5000,
      },
    )

    cleanup()
    await mountLoaded()
    await waitFor(() => expect(pressed('Hand (pan)')).toBe('true'), { timeout: 5000 })
  })
})
