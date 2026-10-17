// The tab icon over a real document kept in this browser: the page feeds the
// favicon from the same connection state it publishes to the shell, so a
// write the store refuses draws the offline icon in the tab strip — the
// surface someone sees with the tab in the background — and the frame's
// notices set the installed app's badge from that state, since the edits are
// now in this tab and nowhere else. The `dot` style keeps the expected icon
// independent of the document's outline.

import { cleanup, fireEvent, render as rtlRender, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AppShell } from '../components/AppShell.js'
import { KeeperNotices } from '../components/connection/KeeperNotices.js'
import { renderFavicon } from '../lib/favicon.js'
import { FoldingBrowserIndex } from '../lib/folding-browser-index.js'
import { resetShellStatusForTests } from '../lib/shell-status-store.js'
import { createUserSettingsStore, STORAGE_KEY } from '../lib/user-settings-store.js'
import { BrowserDocumentPage } from './BrowserDocumentPage.js'
import '../index.css'
import { stubAppBadge } from '../test-utils/app-badge.js'
import { clearWhiteboardDb } from '../test-utils/browser-document.js'
import { expectLoggedFailures } from '../test-utils/browser-setup.js'
import { claimIsolatedWhiteboardDb } from '../test-utils/isolated-whiteboard-db.js'

claimIsolatedWhiteboardDb('browserdocumentpage-favicon')

const iconHref = () =>
  document.head.querySelector('link[rel="icon"][data-wb-favicon]')?.getAttribute('href') ?? null

describe('the browser page tab icon', () => {
  let badge: ReturnType<typeof stubAppBadge>
  beforeEach(async () => {
    badge = stubAppBadge()
    resetShellStatusForTests()
    await clearWhiteboardDb()
    createUserSettingsStore().update((s) => ({
      ...s,
      appearance: { ...s.appearance, faviconStyle: 'dot' },
    }))
  })
  afterEach(() => {
    cleanup()
    badge.restore()
    resetShellStatusForTests()
    window.localStorage.removeItem(STORAGE_KEY)
  })

  it('draws the offline icon and sets the badge once the store refuses a write', async () => {
    const logged = expectLoggedFailures()
    rtlRender(
      <MemoryRouter initialEntries={['/w/me/default/d/c1']}>
        <AppShell daemon={false} />
        <KeeperNotices />
        <BrowserDocumentPage store={new FoldingBrowserIndex()} />
      </MemoryRouter>,
    )
    await waitFor(
      () => expect(screen.getByTestId('spatial-editor-container')).toBeInTheDocument(),
      { timeout: 5000 },
    )
    const quiet = renderFavicon({ style: 'dot', status: 'quiet', rects: [] })
    const offline = renderFavicon({ style: 'dot', status: 'offline', rects: [] })
    expect(quiet).not.toBe(offline)
    await waitFor(() => expect(iconHref()).toBe(quiet), { timeout: 5000 })
    expect(badge.set).not.toHaveBeenCalled()
    // Found before the store is refused: the title renders from a read, and
    // once every transaction throws it would never appear.
    const title = await screen.findByRole('textbox', { name: /title/i }, { timeout: 5000 })
    const transaction = IDBDatabase.prototype.transaction
    IDBDatabase.prototype.transaction = () => {
      throw new Error('storage refused the write (induced)')
    }
    try {
      fireEvent.change(title, { target: { value: 'Renamed while the store is down' } })
      fireEvent.keyDown(title, { key: 'Enter' })
      fireEvent.blur(title)
      await waitFor(
        () => expect(screen.getByTestId('shell-mark').getAttribute('data-storage')).toBe('failed'),
        { timeout: 5000 },
      )
      await waitFor(() => expect(iconHref()).toBe(offline), { timeout: 3000 })
      expect(badge.set).toHaveBeenCalled()
    } finally {
      IDBDatabase.prototype.transaction = transaction
    }
    await waitFor(() => expect(logged.length).toBeGreaterThan(0))
  })
})
