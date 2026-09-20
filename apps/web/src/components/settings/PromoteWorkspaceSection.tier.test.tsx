/**
 * The "This workspace" section's read-plane tier line (ADR-0042 S6):
 * read-only, sourced from GET /api/workspaces matched by workspaceId (never
 * the first row), and rendered only when that row carries a tier. Kept out
 * of PromoteWorkspaceSection.browser.test.tsx / .fold-failure.browser.test.tsx
 * (which never pass workspaceId, so this effect is a no-op there).
 */

import type { ReplicaTier } from '@kamiazya/whiteboard-daemon-client/api-contracts/replica-key'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { REPLICA_TIER_COPY } from '../../lib/replica-tier-copy.js'
import { PromoteWorkspaceSection } from './PromoteWorkspaceSection.js'

afterEach(cleanup)

const DAEMON = { baseUrl: 'http://127.0.0.1:9999', token: 'tok' }

function settingsStore() {
  return {
    load: () => ({ migration: {} }) as never,
    update: () => {},
  }
}

function stubFor(workspaces: Array<{ workspaceId: string; tier?: ReplicaTier }>, status = 200) {
  return vi.fn(
    async () => new Response(JSON.stringify({ workspaces }), { status }),
  ) as unknown as typeof globalThis.fetch & ReturnType<typeof vi.fn>
}

describe('PromoteWorkspaceSection — read-plane tier line', () => {
  it.each([
    'no-offline',
    'offline',
    'bounded',
  ] as const)('shows the %s sentence for the row matching workspaceId, ignoring a decoy row', async (tier) => {
    const stub = stubFor([
      { workspaceId: 'ws-other', tier: 'bounded' },
      { workspaceId: 'ws-1', tier },
    ])
    render(
      <PromoteWorkspaceSection
        daemon={DAEMON}
        settingsStore={settingsStore()}
        workspaceId="ws-1"
        baseFetch={stub}
      />,
    )
    const line = await screen.findByTestId('replica-tier-line')
    expect(line.textContent).toBe(REPLICA_TIER_COPY[tier])
  })

  it('renders the literal offline sentence (guards a copy-module swap)', async () => {
    const stub = stubFor([{ workspaceId: 'ws-1', tier: 'offline' }])
    render(
      <PromoteWorkspaceSection
        daemon={DAEMON}
        settingsStore={settingsStore()}
        workspaceId="ws-1"
        baseFetch={stub}
      />,
    )
    const line = await screen.findByTestId('replica-tier-line')
    expect(line.textContent).toBe('A copy is kept on this device while this tab stays open.')
  })

  it('renders the literal bounded sentence (guards a copy-module swap)', async () => {
    const stub = stubFor([{ workspaceId: 'ws-1', tier: 'bounded' }])
    render(
      <PromoteWorkspaceSection
        daemon={DAEMON}
        settingsStore={settingsStore()}
        workspaceId="ws-1"
        baseFetch={stub}
      />,
    )
    const line = await screen.findByTestId('replica-tier-line')
    expect(line.textContent).toBe('A copy is kept on this device for a limited time.')
  })

  it('renders nothing when the matching row carries no tier', async () => {
    const stub = stubFor([{ workspaceId: 'ws-1' }])
    render(
      <PromoteWorkspaceSection
        daemon={DAEMON}
        settingsStore={settingsStore()}
        workspaceId="ws-1"
        baseFetch={stub}
      />,
    )
    await waitFor(() => expect(stub).toHaveBeenCalled())
    expect(screen.queryByTestId('replica-tier-line')).toBeNull()
  })

  it('renders nothing, and raises no unhandled rejection, when the request fails', async () => {
    const stub = stubFor([], 404)
    render(
      <PromoteWorkspaceSection
        daemon={DAEMON}
        settingsStore={settingsStore()}
        workspaceId="ws-1"
        baseFetch={stub}
      />,
    )
    await waitFor(() => expect(stub).toHaveBeenCalled())
    expect(screen.queryByTestId('replica-tier-line')).toBeNull()
  })

  it('never fetches without a daemon or without a workspace id', async () => {
    const stub = stubFor([{ workspaceId: 'ws-1', tier: 'offline' }])
    render(<PromoteWorkspaceSection settingsStore={settingsStore()} baseFetch={stub} />)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(stub).not.toHaveBeenCalled()
    expect(screen.queryByTestId('replica-tier-line')).toBeNull()
  })

  it('clears the previous tier line immediately when workspaceId changes, before the new fetch resolves', async () => {
    const stub = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ workspaces: [{ workspaceId: 'ws-1', tier: 'offline' }] }), {
          status: 200,
        }),
      )
      .mockReturnValueOnce(new Promise<Response>(() => {})) as unknown as typeof globalThis.fetch &
      ReturnType<typeof vi.fn>
    const { rerender } = render(
      <PromoteWorkspaceSection
        daemon={DAEMON}
        settingsStore={settingsStore()}
        workspaceId="ws-1"
        baseFetch={stub}
      />,
    )
    await screen.findByTestId('replica-tier-line')

    rerender(
      <PromoteWorkspaceSection
        daemon={DAEMON}
        settingsStore={settingsStore()}
        workspaceId="ws-2"
        baseFetch={stub}
      />,
    )

    // Synchronous: the second fetch above never resolves, so a still-present
    // line here can only be the STALE ws-1 sentence.
    expect(screen.queryByTestId('replica-tier-line')).toBeNull()
  })

  it('discards a stale in-flight response for the old workspaceId once a newer one has resolved', async () => {
    const deferred: Array<(response: Response) => void> = []
    const stub = vi.fn(
      () => new Promise<Response>((resolve) => deferred.push(resolve)),
    ) as unknown as typeof globalThis.fetch & ReturnType<typeof vi.fn>
    const { rerender } = render(
      <PromoteWorkspaceSection
        daemon={DAEMON}
        settingsStore={settingsStore()}
        workspaceId="ws-1"
        baseFetch={stub}
      />,
    )
    await waitFor(() => expect(stub).toHaveBeenCalledTimes(1))

    rerender(
      <PromoteWorkspaceSection
        daemon={DAEMON}
        settingsStore={settingsStore()}
        workspaceId="ws-2"
        baseFetch={stub}
      />,
    )
    await waitFor(() => expect(stub).toHaveBeenCalledTimes(2))

    const rows = {
      workspaces: [
        { workspaceId: 'ws-1', tier: 'offline' },
        { workspaceId: 'ws-2', tier: 'bounded' },
      ],
    }
    // Resolve the NEWER (ws-2) request first, then the stale ws-1 one.
    deferred[1]?.(new Response(JSON.stringify(rows), { status: 200 }))
    const line = await screen.findByTestId('replica-tier-line')
    expect(line.textContent).toBe(REPLICA_TIER_COPY.bounded)

    deferred[0]?.(new Response(JSON.stringify(rows), { status: 200 }))
    // The stale response's own row is ws-1's — only the cleanup's `cancelled`
    // guard stops it from clobbering the current ws-2 line. A macrotask
    // boundary drains the response's own `.json()` microtask chain, which a
    // fixed count of `Promise.resolve()` awaits cannot be sized against.
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(screen.getByTestId('replica-tier-line').textContent).toBe(REPLICA_TIER_COPY.bounded)
  })

  it('scans the rendered section and the copy module for banned jargon', async () => {
    const stub = stubFor([{ workspaceId: 'ws-1', tier: 'no-offline' }])
    render(
      <PromoteWorkspaceSection
        daemon={DAEMON}
        settingsStore={settingsStore()}
        workspaceId="ws-1"
        baseFetch={stub}
      />,
    )
    await screen.findByTestId('replica-tier-line')
    const section = screen.getByLabelText('This workspace')
    const jargon = /tier|replica|revoked|macaroon|L1|HKDF|epoch/i
    expect(section.textContent).not.toMatch(jargon)
    expect(Object.values(REPLICA_TIER_COPY).join(' ')).not.toMatch(jargon)
  })
})
