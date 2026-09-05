/**
 * REAL element fullscreen — enter via a real activated click, exit via the
 * floating control — against the browser's own fullscreenchange and
 * document.fullscreenElement. The jsdom fullscreen suite models the
 * capability with stubs (rejection and no-API branches it can state
 * honestly); what it cannot state is that the browser grants the request,
 * fires the event, and that focus hand-off survives the real top-layer
 * transitions. Focus-restore is the class behind three root-caused flakes,
 * so it is pinned here against the real thing.
 */
import { generateDocumentId } from '@kamiazya/whiteboard-model'
import { act, cleanup, render as rtlRender, screen, waitFor } from '@testing-library/react'
import type { ReactElement } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, expect, it } from 'vitest'
import { userEvent } from 'vitest/browser'
import { AppShell } from '../components/AppShell.js'
import {
  getBrowserWorkspaceId,
  setBrowserWorkspaceIdForTests,
} from '../lib/browser-workspace-id.js'
import type { DocumentSnapshot } from '../lib/whiteboard-client.js'
import { LocalStoreDouble } from '../test-utils/local-index.js'
import { BrowserDocumentPage } from './BrowserDocumentPage.js'
import '../index.css'

// No real IndexedDB in this file (`LocalStoreDouble` is in-memory), so
// nothing else in this page's module graph resolves the workspace-id
// accessor the way `claimIsolatedWhiteboardDb` would for a real-DB file.
setBrowserWorkspaceIdForTests(generateDocumentId())

afterEach(async () => {
  if (document.fullscreenElement !== null) {
    await document.exitFullscreen()
  }
  cleanup()
})

// The shell above the page, the way App composes them: the toggle is the
// shell's, and what fullscreen hides is both rows.
function render(ui: ReactElement) {
  return rtlRender(
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
      <MemoryRouter initialEntries={['/']}>
        <AppShell daemon={false} />
        <div style={{ minHeight: 0, flex: 1 }}>{ui}</div>
      </MemoryRouter>
    </div>,
  )
}

const snap: DocumentSnapshot = {
  documentId: '0PV05AFMSY38DJQW16BGNTZ49E',
  workspaceId: getBrowserWorkspaceId(),
  path: 'canvas-a',
  name: 'Canvas A',
  kind: 'spatial',
  updatedAt: '2026-04-23T00:00:00Z',
}

async function renderLoaded() {
  const store = new LocalStoreDouble()
  await store.setDefaultDocumentId('0PV05AFMSY38DJQW16BGNTZ49E')
  await store.save(snap)
  await act(async () => {
    render(<BrowserDocumentPage store={store.index} pointer={store.pointer} clock={store.clock} />)
  })
  await screen.findByRole('button', { name: 'Back to documents' }, { timeout: 10_000 })
}

it('really enters fullscreen on click, focuses the exit control, and restores focus on exit', async () => {
  await renderLoaded()

  // A real click carries the user activation requestFullscreen requires.
  await userEvent.click(screen.getByRole('button', { name: 'Fullscreen' }))
  await waitFor(() => expect(document.fullscreenElement).not.toBeNull(), { timeout: 10_000 })

  // Both chrome rows step aside; the one way back out holds focus.
  await waitFor(() =>
    expect(screen.queryByRole('button', { name: 'Back to documents' })).toBeNull(),
  )
  expect(screen.queryByTestId('shell-settings')).toBeNull()
  const exit = await screen.findByRole('button', { name: 'Exit fullscreen' })
  await waitFor(() => expect(document.activeElement).toBe(exit))

  await userEvent.click(exit)
  await waitFor(() => expect(document.fullscreenElement).toBeNull(), { timeout: 10_000 })

  // The chrome returns, and focus lands back on the toggle that started it.
  await screen.findByRole('button', { name: 'Back to documents' })
  await waitFor(() =>
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Fullscreen' })),
  )
})
