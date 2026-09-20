// @vitest-environment jsdom
import { forgetAll, sessionKey } from '@kamiazya/whiteboard-daemon-client/replica-session-key'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { disconnectFromDaemon } from './disconnect-daemon.js'
import { markReplica } from './replica-store.js'
import { withReplicaEntry } from './replicas.js'
import { createUserSettingsStore } from './user-settings-store.js'

const A = 'http://127.0.0.1:3099'
const B = 'http://127.0.0.1:4000'

function keyResponse(): Response {
  return new Response(
    JSON.stringify({
      workspaceKey: 'AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA',
      workspaceKeySalt: 'oKGio6SlpqeoqaqrrK2urw',
      tier: 'offline',
    }),
    { status: 200 },
  )
}

beforeEach(() => {
  localStorage.clear()
  forgetAll()
})

describe('disconnectFromDaemon', () => {
  it('clears the stored target so the next load is not daemon-backed', () => {
    const store = createUserSettingsStore()
    store.update((c) => ({ ...c, storage: { ...c.storage, daemonBaseUrl: A } }))
    disconnectFromDaemon(store, A)
    expect(createUserSettingsStore().load().storage.daemonBaseUrl).toBeUndefined()
  })

  // Forgetting alone is not enough: the default port range is rescanned on
  // every visit, so the same daemon would come straight back.
  it('records the dismissal and drops it from the known list', () => {
    const store = createUserSettingsStore()
    store.update((c) => ({ ...c, storage: { ...c.storage, knownDaemonBaseUrls: [A, B] } }))
    disconnectFromDaemon(store, A)
    const storage = createUserSettingsStore().load().storage
    expect(storage.dismissedDaemonBaseUrls).toContain(A)
    expect(storage.knownDaemonBaseUrls).toEqual([B])
  })

  // Another daemon's stored target is none of this call's business.
  it('leaves a different daemon connected', () => {
    const store = createUserSettingsStore()
    store.update((c) => ({ ...c, storage: { ...c.storage, daemonBaseUrl: B } }))
    disconnectFromDaemon(store, A)
    expect(createUserSettingsStore().load().storage.daemonBaseUrl).toBe(B)
  })

  it('is a skip-list, not an archive — bounded at five', () => {
    const store = createUserSettingsStore()
    for (const port of [3000, 3001, 3002, 3003, 3004, 3005]) {
      disconnectFromDaemon(store, `http://127.0.0.1:${port}`)
    }
    expect(createUserSettingsStore().load().storage.dismissedDaemonBaseUrls).toHaveLength(5)
  })

  it('forgets a held replica key for this daemon: the next ask hits a fresh fetch instead of the cache', async () => {
    const workspaceId = 'ws-forgotten'
    const store = createUserSettingsStore()
    store.update((current) =>
      withReplicaEntry(current, workspaceId, {
        daemonBaseUrl: A,
        syncedAt: new Date().toISOString(),
      }),
    )
    markReplica(workspaceId, A)

    const fetchImpl = vi.fn(async () => keyResponse())
    const source = {
      fetch: fetchImpl,
      bindSession: async () => ({ ok: false as const, reason: 'no-passkey' as const }),
    }
    const first = await sessionKey(A, workspaceId, source)
    expect(first.kind).toBe('key')
    expect(fetchImpl).toHaveBeenCalledTimes(1)

    disconnectFromDaemon(store, A)

    // A held key answers from cache with no fetch; a forgotten one is a
    // fresh mint — this is the only externally-observable difference,
    // since `forget` clears no field a test can read directly.
    await sessionKey(A, workspaceId, source)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })
})
