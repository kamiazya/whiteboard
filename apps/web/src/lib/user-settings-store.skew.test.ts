import { beforeEach, describe, expect, it } from 'vitest'
import { createUserSettingsStore, STORAGE_KEY } from './user-settings-store.js'

describe('a payload written by a build that knows more fields', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  // A key one level or more down: the payload is a newer build's, written
  // under the same version because adding an optional field does not bump it.
  const newer = {
    version: 5,
    storage: {
      daemonBaseUrl: 'http://127.0.0.1:3099',
      someNewerKnob: true,
      replicas: {
        'ws-a': {
          daemonBaseUrl: 'http://127.0.0.1:3099',
          syncedAt: '2026-09-01T00:00:00.000Z',
          newerReplicaField: 1,
        },
      },
    },
    migration: {
      promotion: {
        at: '2026-09-01T00:00:00.000Z',
        workspaceId: 'ws-a',
        ok: true,
        promotedCount: 2,
        shadowedPaths: [],
        blobsMissing: [],
        blobsFailed: [],
        newerPromotionField: 'x',
      },
    },
    capabilities: { webMcpEnabled: true, newerCapability: 1 },
    appearance: { faviconStyle: 'dot', someFutureKnob: 1 },
  }

  it('reads every field it knows and ignores the one it does not, at every depth', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(newer))

    const loaded = createUserSettingsStore().load()

    expect(loaded.storage.daemonBaseUrl).toBe('http://127.0.0.1:3099')
    expect(loaded.storage.replicas?.['ws-a']?.syncedAt).toBe('2026-09-01T00:00:00.000Z')
    expect(loaded.migration.promotion?.ok).toBe(true)
    expect(loaded.capabilities.webMcpEnabled).toBe(true)
    expect(loaded.appearance?.faviconStyle).toBe('dot')
  })

  it('keeps the daemon URL, replicas and promotion record through an unrelated update', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(newer))

    createUserSettingsStore().update((current) => ({
      ...current,
      appearance: { faviconStyle: 'minimap' },
    }))

    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null')
    expect(stored.storage.daemonBaseUrl).toBe('http://127.0.0.1:3099')
    expect(Object.keys(stored.storage.replicas)).toEqual(['ws-a'])
    expect(stored.migration.promotion.workspaceId).toBe('ws-a')
    expect(stored.appearance.faviconStyle).toBe('minimap')
  })
})
