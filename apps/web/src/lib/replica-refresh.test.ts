/**
 * ADR-0023 decision 5's arrival path: working on a daemon workspace quietly
 * refreshes this browser's replica of it. What this file pins is the
 * scheduling contract — deduped while the registry entry is FRESH, re-armed
 * once it goes stale (a long session must not let the replica age all day),
 * off the critical path, registry written only on a successful pull.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  resetReplicaRefreshForTests,
  scheduleReplicaPush,
  scheduleReplicaRefresh,
} from './replica-refresh.js'
import { withReplicaEntry } from './replicas.js'
import { createUserSettingsStore } from './user-settings-store.js'

const BASE = 'http://127.0.0.1:3099'
const WS = '01ARZ3NDEKTSV4RRFFQ69G5FA0'

/** The daemon's workspace list, which the refresh resolves handles against. */
function listStub(rows: Array<{ workspaceId: string; segment?: string }>): typeof globalThis.fetch {
  return (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString()
    if (url.endsWith('/api/workspaces')) return Response.json({ workspaces: rows })
    return new Response('', { status: 500 })
  }) as typeof globalThis.fetch
}

function deps(over?: Partial<Parameters<typeof scheduleReplicaRefresh>[0]>) {
  return {
    fetch: listStub([{ workspaceId: WS, segment: 'dev' }]),
    daemonBaseUrl: BASE,
    workspaceId: WS,
    // Synchronous scheduling so the test observes the completed run.
    schedule: (run: () => void) => run(),
    ...over,
  }
}

beforeEach(() => {
  localStorage.clear()
  resetReplicaRefreshForTests()
  // The dedupe compares the registry stamp against now, so the clock is
  // pinned NEAR the stamps the stubs record — otherwise every entry reads
  // as ancient and the dedupe never holds.
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-09-01T12:05:00.000Z'))
})
afterEach(() => {
  vi.useRealTimers()
  resetReplicaRefreshForTests()
})

describe('scheduleReplicaRefresh', () => {
  it('pulls once per daemon+workspace per session, and records the sync', async () => {
    const cache = vi
      .fn()
      .mockResolvedValue({ kind: 'ok', syncedAt: '2026-09-01T12:00:00.000Z', documentCount: 3 })
    scheduleReplicaRefresh(deps({ cache }))
    scheduleReplicaRefresh(deps({ cache }))
    await vi.waitFor(() => expect(cache).toHaveBeenCalledTimes(1))

    await vi.waitFor(() => {
      const replicas = createUserSettingsStore().load().storage.replicas
      // segment/displayName captured at sync time: offline is exactly when
      // they cannot be resolved against the daemon, and the URL usually
      // carries the segment while this registry keys by the canonical id.
      expect(replicas?.[WS]).toEqual({
        daemonBaseUrl: BASE,
        syncedAt: '2026-09-01T12:00:00.000Z',
        segment: 'dev',
      })
    })
  })

  it('a different workspace on the same daemon is its own refresh', async () => {
    const cache = vi
      .fn()
      .mockResolvedValue({ kind: 'ok', syncedAt: '2026-09-01T12:00:00.000Z', documentCount: 0 })
    scheduleReplicaRefresh(deps({ cache }))
    scheduleReplicaRefresh(
      deps({
        cache,
        fetch: listStub([{ workspaceId: '01ARZ3NDEKTSV4RRFFQ69G5FA1' }]),
        workspaceId: '01ARZ3NDEKTSV4RRFFQ69G5FA1',
      }),
    )
    await vi.waitFor(() => expect(cache).toHaveBeenCalledTimes(2))
  })

  it('a page addressing the workspace by segment still caches under the canonical id', async () => {
    // ADR-0019's two-name trap, hit in a real browser: the page carries the
    // handle ('dev'), the switcher rows carry the canonical id, and a
    // registry keyed by whichever the page had matches nothing. The refresh
    // resolves against the daemon's own list before caching.
    const cache = vi
      .fn()
      .mockResolvedValue({ kind: 'ok', syncedAt: '2026-09-01T12:00:00.000Z', documentCount: 1 })
    scheduleReplicaRefresh(deps({ cache, workspaceId: 'dev' }))
    await vi.waitFor(() => expect(cache).toHaveBeenCalledTimes(1))
    expect(cache.mock.calls[0]?.[0]?.workspaceId).toBe(WS)
    await vi.waitFor(() => {
      expect(createUserSettingsStore().load().storage.replicas?.[WS]).toBeTruthy()
    })
  })

  it('an unresolvable handle caches nothing', async () => {
    const cache = vi.fn().mockResolvedValue({ kind: 'ok', syncedAt: 'x', documentCount: 0 })
    scheduleReplicaRefresh(
      deps({
        cache,
        workspaceId: 'nobody-home',
        fetch: listStub([{ workspaceId: WS, segment: 'dev' }]),
      }),
    )
    await new Promise((r) => setTimeout(r, 50))
    expect(cache).not.toHaveBeenCalled()
  })

  it('a stale registry entry re-arms the dedupe; a fresh one holds it', async () => {
    const cache = vi.fn().mockImplementation(async () => ({
      kind: 'ok' as const,
      syncedAt: new Date().toISOString(),
      documentCount: 1,
    }))
    scheduleReplicaRefresh(deps({ cache }))
    await vi.waitFor(() => expect(cache).toHaveBeenCalledTimes(1))
    // Fresh entry: the dedupe holds.
    scheduleReplicaRefresh(deps({ cache }))
    await new Promise((r) => setTimeout(r, 20))
    expect(cache).toHaveBeenCalledTimes(1)
    // The entry ages past the staleness window mid-session: the next
    // resolve pulls again instead of letting the replica age all day.
    vi.setSystemTime(new Date('2026-09-01T12:25:00.000Z'))
    scheduleReplicaRefresh(deps({ cache }))
    await vi.waitFor(() => expect(cache).toHaveBeenCalledTimes(2))
    // And the refreshed stamp holds the dedupe again.
    scheduleReplicaRefresh(deps({ cache }))
    await new Promise((r) => setTimeout(r, 20))
    expect(cache).toHaveBeenCalledTimes(2)
  })

  it('a failed pull is retried on the next resolve, not abandoned for the session', async () => {
    const cache = vi
      .fn()
      .mockResolvedValueOnce({ kind: 'failed', reason: 'offline' })
      .mockResolvedValue({ kind: 'ok', syncedAt: new Date().toISOString(), documentCount: 1 })
    scheduleReplicaRefresh(deps({ cache }))
    await vi.waitFor(() => expect(cache).toHaveBeenCalledTimes(1))
    // No registry entry was written, so nothing says the replica is fresh —
    // the next resolve tries again.
    scheduleReplicaRefresh(deps({ cache }))
    await vi.waitFor(() => expect(cache).toHaveBeenCalledTimes(2))
  })

  it('a failed pull records nothing, and never throws', async () => {
    const cache = vi.fn().mockResolvedValue({ kind: 'failed', reason: 'offline' })
    scheduleReplicaRefresh(deps({ cache }))
    await vi.waitFor(() => expect(cache).toHaveBeenCalledTimes(1))
    expect(createUserSettingsStore().load().storage.replicas?.[WS]).toBeUndefined()
  })
})

describe('scheduleReplicaPush', () => {
  const FRONTIER_SYNCED = 'c3luY2Vk' // "synced"
  const FRONTIER_LOCAL = 'bG9jYWw=' // "local"

  function seedEntry(syncedFrontier?: string) {
    createUserSettingsStore().update((current) =>
      withReplicaEntry(current, WS, {
        daemonBaseUrl: BASE,
        syncedAt: '2026-09-01T12:00:00.000Z',
        segment: 'dev',
        ...(syncedFrontier === undefined ? {} : { syncedFrontier }),
      }),
    )
  }

  function pushDeps(over?: Record<string, unknown>) {
    return {
      fetch: listStub([{ workspaceId: WS, segment: 'dev' }]),
      daemonBaseUrl: BASE,
      workspaceId: 'dev',
      schedule: (run: () => void) => run(),
      readStoredFrontier: vi.fn().mockResolvedValue(FRONTIER_LOCAL),
      push: vi.fn().mockResolvedValue({
        kind: 'ok',
        syncedAt: '2026-09-01T12:06:00.000Z',
        syncedFrontier: FRONTIER_LOCAL,
      }),
      ...over,
    }
  }

  it('a dirty replica ships, and the registry keeps its other fields', async () => {
    seedEntry(FRONTIER_SYNCED)
    const d = pushDeps()
    scheduleReplicaPush(d as never)
    await vi.waitFor(() => expect(d.push).toHaveBeenCalledTimes(1))
    expect(d.push.mock.calls[0]?.[0]).toMatchObject({
      workspaceId: WS,
      syncedFrontier: FRONTIER_SYNCED,
    })
    await vi.waitFor(() => {
      const entry = createUserSettingsStore().load().storage.replicas?.[WS]
      expect(entry?.syncedFrontier).toBe(FRONTIER_LOCAL)
      expect(entry?.syncedAt).toBe('2026-09-01T12:06:00.000Z')
      // The merge write must not drop what it did not mention.
      expect(entry?.segment).toBe('dev')
    })
  })

  it('byte-equal frontiers ship nothing — no push, no network', async () => {
    seedEntry(FRONTIER_LOCAL)
    const d = pushDeps({ readStoredFrontier: vi.fn().mockResolvedValue(FRONTIER_LOCAL) })
    scheduleReplicaPush(d as never)
    await new Promise((r) => setTimeout(r, 20))
    expect(d.push).not.toHaveBeenCalled()
  })

  it('no registry entry for this daemon ships nothing', async () => {
    const d = pushDeps()
    scheduleReplicaPush(d as never)
    await new Promise((r) => setTimeout(r, 20))
    expect(d.push).not.toHaveBeenCalled()
  })

  it('an entry with NO recorded frontier ships (the one-time snapshot era)', async () => {
    seedEntry(undefined)
    const d = pushDeps()
    scheduleReplicaPush(d as never)
    await vi.waitFor(() => expect(d.push).toHaveBeenCalledTimes(1))
    expect(d.push.mock.calls[0]?.[0]?.syncedFrontier).toBeUndefined()
  })

  it('a failed push leaves the registry alone and the next resolve retries', async () => {
    seedEntry(FRONTIER_SYNCED)
    const failing = vi.fn().mockResolvedValue({ kind: 'failed', reason: 'offline' })
    const d = pushDeps({ push: failing })
    scheduleReplicaPush(d as never)
    await vi.waitFor(() => expect(failing).toHaveBeenCalledTimes(1))
    expect(createUserSettingsStore().load().storage.replicas?.[WS]?.syncedFrontier).toBe(
      FRONTIER_SYNCED,
    )
    scheduleReplicaPush(d as never)
    await vi.waitFor(() => expect(failing).toHaveBeenCalledTimes(2))
  })
})
