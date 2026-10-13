/**
 * Preparing the move reads two things — the daemon's workspace listing and
 * this browser's own record — and a failure of either says which: someone
 * whose stored copy cannot be read, or whose daemon refused the listing, must
 * not be sent to check a connection that works.
 */
import { StoredDocumentUnreadableError } from '@kamiazya/whiteboard-ports'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { userEvent } from 'vitest/browser'
import { ensureBrowserWorkspace } from '../../lib/browser-document-summary.js'
import { BrowserWorkspaceDocs } from '../../lib/browser-workspace-docs.js'
import { getBrowserWorkspaceId } from '../../lib/browser-workspace-id.js'
import { FoldingBrowserIndex } from '../../lib/folding-browser-index.js'
import { createUserSettingsStore, STORAGE_KEY } from '../../lib/user-settings-store.js'
import { clearWhiteboardDb } from '../../test-utils/browser-document.js'
import { expectLoggedFailures } from '../../test-utils/browser-setup.js'
import { claimIsolatedWhiteboardDb } from '../../test-utils/isolated-whiteboard-db.js'
import { PromoteWorkspaceSection } from './PromoteWorkspaceSection.js'

claimIsolatedWhiteboardDb('promote-open-failure')

const DAEMON = { baseUrl: 'http://127.0.0.1:3099' }

/** A daemon answering only the listing — none of these cases gets further. */
function listingStub(answer: () => Response): typeof globalThis.fetch {
  return (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString()
    if (url.endsWith('/api/workspaces')) return answer()
    throw new Error(`unexpected fetch: ${url}`)
  }) as typeof globalThis.fetch
}

const listsOne = listingStub(() => Response.json({ workspaces: [{ workspaceId: 'ws-a' }] }))

async function seedOneDocument(): Promise<void> {
  const index = new FoldingBrowserIndex()
  await ensureBrowserWorkspace(index)
  await index.createDocument({
    workspaceId: getBrowserWorkspaceId(),
    path: 'notes/roadmap',
    kind: 'markdown',
  })
}

async function openAndReadNotice(baseFetch: typeof globalThis.fetch): Promise<HTMLElement> {
  render(
    <PromoteWorkspaceSection
      daemon={DAEMON}
      settingsStore={createUserSettingsStore()}
      baseFetch={baseFetch}
    />,
  )
  await userEvent.click(screen.getByTestId('promote-workspace-open'))
  return screen.findByTestId('promote-unavailable')
}

beforeEach(async () => {
  localStorage.removeItem(STORAGE_KEY)
  await clearWhiteboardDb()
  await seedOneDocument()
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('PromoteWorkspaceSection preparing the move', () => {
  it('discloses an unreachable daemon and keeps the trigger clickable for a retry', async () => {
    const unreachable = (async () => {
      throw new TypeError('Failed to fetch')
    }) as typeof globalThis.fetch
    const notice = await openAndReadNotice(unreachable)
    expect(notice.textContent).toMatch(/could not reach the daemon/i)
    // Recoverable, not a dead end: the same trigger retries, and a daemon
    // that answers this time opens the confirmation.
    expect(screen.getByTestId('promote-workspace-open').hasAttribute('disabled')).toBe(false)
  })

  it('quotes a daemon that refuses the listing rather than calling it unreachable', async () => {
    const logged = expectLoggedFailures()
    const refusing = listingStub(() =>
      Response.json({ title: 'Only members of this daemon can list it.' }, { status: 403 }),
    )
    const notice = await openAndReadNotice(refusing)
    expect(notice.textContent).toMatch(/only members of this daemon can list it/i)
    expect(notice.textContent).not.toMatch(/reach/i)
    expect(logged.some((line) => /refused the workspace listing/i.test(line))).toBe(true)
  })

  it('names an unreadable browser copy while the daemon answers the listing', async () => {
    const logged = expectLoggedFailures()
    vi.spyOn(BrowserWorkspaceDocs.prototype, 'open').mockRejectedValue(
      new StoredDocumentUnreadableError('malformed', 'a delta does not decode'),
    )
    const notice = await openAndReadNotice(listsOne)
    expect(notice.textContent).toMatch(/this browser's copy of this workspace could not be read/i)
    expect(notice.textContent).not.toMatch(/reach/i)
    expect(logged.some((line) => /stored workspace could not be read/i.test(line))).toBe(true)
  })
})
