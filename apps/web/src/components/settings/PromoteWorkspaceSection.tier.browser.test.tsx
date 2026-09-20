/**
 * web-browser layer: renders the real section through the real
 * createDaemonFetch/listWorkspaces/Zod path against a stubbed daemon, and
 * captures the PR figure for the read-plane tier line (ADR-0042 S6).
 */
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { page } from 'vitest/browser'
import { REPLICA_TIER_COPY } from '../../lib/replica-tier-copy.js'
import { PromoteWorkspaceSection } from './PromoteWorkspaceSection.js'

afterEach(cleanup)

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('PromoteWorkspaceSection tier line', () => {
  it('shows what this device keeps of the workspace', async () => {
    const fetchStub = async () =>
      jsonResponse({ workspaces: [{ workspaceId: 'ws-1', tier: 'offline' }] })

    render(
      <PromoteWorkspaceSection
        daemon={{ baseUrl: 'http://127.0.0.1:9999', token: 'tok' }}
        settingsStore={{ load: () => ({ migration: {} }) as never, update: () => {} }}
        workspaceId="ws-1"
        baseFetch={fetchStub as unknown as typeof globalThis.fetch}
      />,
    )

    const line = await screen.findByText(REPLICA_TIER_COPY.offline)
    expect(line.getAttribute('role')).toBeNull()

    const before = document.querySelectorAll('[role="status"]').length

    await page.screenshot({
      path: '../../../../../tmp/screenshots/s6-tier-line.png',
    })

    expect(document.querySelectorAll('[role="status"]').length).toBe(before)
  })
})
