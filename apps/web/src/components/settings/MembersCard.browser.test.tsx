/**
 * web-browser layer on purpose: the confirm step is a real Radix
 * AlertDialog, and focus trapping / keyboard traversal is real pointer/
 * focus risk that jsdom cannot exercise (AGENTS.md's browser-mode section).
 * Captures the two PR figures: the loaded card, and the confirm naming the
 * member before it is confirmed.
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import { DaemonApiContext } from '../../contexts/DaemonApiContext.js'
import { MembersCard } from './MembersCard.js'

afterEach(cleanup)

const WORKSPACE_ID = 'ws-1'
const MEMBERS_URL = `/api/workspaces/${WORKSPACE_ID}/members`
const CREDENTIALS_URL = '/api/pairing/credentials'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function renderCard() {
  let removed = false
  const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    if (method === 'DELETE' && url === `${MEMBERS_URL}/profile-ada`) {
      removed = true
      return jsonResponse({ removed: true, sessionsEnded: 1 })
    }
    if (method === 'GET' && url === MEMBERS_URL) {
      return jsonResponse({
        members: removed
          ? []
          : [
              {
                profileId: 'profile-ada',
                displayName: 'Ada',
                credentials: [{ credentialId: 'c1', origin: 'https://a.example' }],
                createdAt: '2026-09-01T00:00:00.000Z',
              },
            ],
      })
    }
    if (method === 'GET' && url === CREDENTIALS_URL) {
      return jsonResponse({
        credentials: [
          {
            credentialId: 'credential-aaaa1111',
            origin: 'https://a.example',
            backupEligible: true,
            createdAt: '2026-09-01T00:00:00.000Z',
          },
        ],
      })
    }
    return jsonResponse({}, 404)
  })
  render(
    <DaemonApiContext.Provider value={fetchFn as unknown as typeof globalThis.fetch}>
      <MembersCard workspaceId={WORKSPACE_ID} />
    </DaemonApiContext.Provider>,
  )
}

/** Tabs forward until the active element matches, or gives up. */
async function tabUntil(matches: (el: Element | null) => boolean, limit = 20): Promise<void> {
  for (let i = 0; i < limit && !matches(document.activeElement); i += 1) {
    await userEvent.tab()
  }
  expect(matches(document.activeElement)).toBe(true)
}

describe('MembersCard (browser)', () => {
  it('removes a member from the keyboard: Tab, Enter opens confirm, Tab+Enter confirms, focus lands on the heading', async () => {
    renderCard()
    await screen.findByText('Ada')

    await page.screenshot({
      path: '../../../../../tmp/screenshots/s0-5-members-card.png',
    })

    await tabUntil((el) => el?.getAttribute('aria-label') === 'Remove Ada from this workspace')
    await userEvent.keyboard('{Enter}')

    const dialog = await screen.findByRole('alertdialog')
    // Radix focuses Cancel by default when the dialog opens.
    expect(dialog.contains(document.activeElement)).toBe(true)

    await tabUntil((el) => el?.textContent === 'Remove')
    expect(dialog.contains(document.activeElement)).toBe(true)

    await page.screenshot({
      path: '../../../../../tmp/screenshots/s0-5-members-confirm.png',
    })

    await userEvent.keyboard('{Enter}')

    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    await waitFor(() => expect(screen.queryAllByTestId(/^member-/).length).toBe(0))
    expect(screen.getByRole('heading', { name: 'Members' })).toBe(document.activeElement)
  })

  it("Escape closes the confirm and returns focus to the row's Remove button", async () => {
    renderCard()
    await screen.findByText('Ada')

    await tabUntil((el) => el?.getAttribute('aria-label') === 'Remove Ada from this workspace')
    await userEvent.keyboard('{Enter}')
    await screen.findByRole('alertdialog')

    await userEvent.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    expect(document.activeElement?.getAttribute('aria-label')).toBe(
      'Remove Ada from this workspace',
    )
  })
})
