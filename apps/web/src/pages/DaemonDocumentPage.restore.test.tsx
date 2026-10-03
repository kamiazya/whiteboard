import { act, cleanup, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as daemonApiClient from '../lib/daemon-api-client.js'
import { FakeDocumentBackend, renderInRouter } from '../test-utils/daemon-page-harness.js'
import { DaemonDocumentPage } from './DaemonDocumentPage.js'

vi.mock('../lib/replica-refresh.js', async () =>
  (await import('../test-utils/daemon-page-harness.js')).replicaRefreshMock(),
)

vi.mock('../lib/daemon-api-client.js', async (importOriginal) =>
  (await import('../test-utils/daemon-page-harness.js')).daemonApiClientMock(importOriginal, [
    'listWorkspaces',
    'listDocuments',
    'createDocument',
  ]),
)

// The daemon announces a restore with `restore_started` and ends it with
// `restore_complete`; this proves the page turns that pair into something a
// person can see and that stops them editing underneath it, which the hook's
// own test cannot (it never renders a page).
const DAEMON_BASE_URL = 'http://127.0.0.1:3099'

describe('DaemonDocumentPage restore wiring', () => {
  let backend: FakeDocumentBackend | null = null

  beforeEach(() => {
    backend = null
    vi.mocked(daemonApiClient.listWorkspaces).mockResolvedValue({
      workspaces: [{ workspaceId: 'w1' }],
    })
    vi.mocked(daemonApiClient.listDocuments).mockResolvedValue({
      documents: [
        { path: 'main', documentId: 'id-main', updatedAt: '2026-01-01', kind: 'spatial' },
      ],
    })
  })

  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
    localStorage.clear()
  })

  async function mountPage(): Promise<void> {
    await act(async () => {
      renderInRouter(
        <DaemonDocumentPage
          daemonBaseUrl={DAEMON_BASE_URL}
          createBackend={() => {
            backend = new FakeDocumentBackend()
            return backend
          }}
        />,
        { container: document.body },
      )
    })
    await waitFor(() => expect(screen.getByTestId('spatial-editor-container')).toBeTruthy())
  }

  const restoreStatus = () => document.querySelector('[data-testid="restore-status"]')
  const editorIsLocked = () =>
    screen.getByTestId('spatial-editor-container').closest('[inert]') !== null

  it('shows nothing and leaves the editor live until a restore starts', async () => {
    await mountPage()

    expect(restoreStatus()).toBeNull()
    expect(editorIsLocked()).toBe(false)
  })

  it('announces a restore by its label and locks the editor until it completes', async () => {
    await mountPage()

    await act(async () => {
      backend?.handlers?.onRestoreStarted?.({ label: 'Before the refactor' })
    })

    const status = restoreStatus()
    expect(status?.textContent).toContain('Restoring Before the refactor…')
    expect(status?.getAttribute('role')).toBe('status')
    expect(status?.getAttribute('aria-live')).toBe('polite')
    // The announcement must outlive the lock: an inert subtree is hidden from
    // assistive technology, so a status inside it would never be read.
    expect(status?.closest('[inert]')).toBeNull()
    expect(editorIsLocked()).toBe(true)

    await act(async () => {
      backend?.handlers?.onRestoreComplete?.()
    })

    expect(restoreStatus()).toBeNull()
    expect(editorIsLocked()).toBe(false)
  })

  it('still announces a restore whose version carries no label', async () => {
    await mountPage()

    await act(async () => {
      backend?.handlers?.onRestoreStarted?.({})
    })

    expect(restoreStatus()?.textContent).toContain('Restoring a saved version…')
    expect(editorIsLocked()).toBe(true)
  })
})
