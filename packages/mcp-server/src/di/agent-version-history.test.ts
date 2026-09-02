import type { VersionHistory } from '@kamiazya/whiteboard-server-core'
import { LoroDoc } from 'loro-crdt'
import { describe, expect, it, vi } from 'vitest'
import { DAEMON_PEER_ID } from '../server/daemon-peer.js'
import type { VersionStore } from '../server/store/version-store.js'
import { agentVersionHistory } from './agent-version-history.js'

function storeSpy() {
  const save = vi.fn(async (_ws: string, path: string, _doc: LoroDoc, opts: unknown) => ({
    id: 'v1',
    path,
    createdAt: '2026-01-01T00:00:00.000Z',
    elementCount: 0,
    auto: false,
    hasThumbnail: false,
    branchName: 'main',
    ...(opts as object),
  }))
  return { store: { save } as unknown as VersionStore, save }
}

describe('agentVersionHistory', () => {
  it('records a save that names no operator as this daemon acting as an agent', async () => {
    const { store, save } = storeSpy()
    const history: VersionHistory = agentVersionHistory(store)

    await history.save('ws', 'notes/plan', new LoroDoc(), { auto: false, label: 'v1' })

    expect(save).toHaveBeenCalledWith('ws', 'notes/plan', expect.any(LoroDoc), {
      auto: false,
      label: 'v1',
      operator: { kind: 'ai', peerId: DAEMON_PEER_ID },
    })
  })

  it('passes a named operator through untouched', async () => {
    const { store, save } = storeSpy()
    const operator = { kind: 'human' as const, peerId: 'p-1', displayName: 'Yuki' }

    await agentVersionHistory(store).save('ws', 'notes/plan', new LoroDoc(), {
      auto: false,
      operator,
    })

    expect(save.mock.calls[0]?.[3]).toEqual({ auto: false, operator })
  })
})
