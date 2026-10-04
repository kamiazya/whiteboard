/**
 * web-browser layer: renders the real section through the real
 * createDaemonFetch/listWorkspaces/Zod path against a stubbed daemon, and
 * pins the read-plane tier line (ADR-0042).
 */
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { REPLICA_TIER_COPY } from '../../lib/replica-tier-copy.js'
import { jsonResponse } from '../../test-utils/json-response.js'
import { PromoteWorkspaceSection } from './PromoteWorkspaceSection.js'

afterEach(cleanup)

describe('PromoteWorkspaceSection tier line', () => {
  it('shows what this device keeps of the workspace', async () => {
    const fetchStub = async () =>
      jsonResponse({ workspaces: [{ workspaceId: 'ws-1', tier: 'offline' }] })

    render(
      <PromoteWorkspaceSection
        daemon={{ baseUrl: 'http://127.0.0.1:9999' }}
        settingsStore={{ load: () => ({ migration: {} }) as never, update: () => {} }}
        workspaceId="ws-1"
        baseFetch={fetchStub as unknown as typeof globalThis.fetch}
      />,
    )

    const line = await screen.findByText(REPLICA_TIER_COPY.offline)
    expect(line.getAttribute('role')).toBeNull()
  })
})
