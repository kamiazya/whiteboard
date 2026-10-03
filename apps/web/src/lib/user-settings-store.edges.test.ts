/**
 * What the store does at the edges its main suite does not walk: a count a
 * migration must carry rather than default, a newer key that fails to parse
 * beside an older one that would, and a write the schema refuses.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import {
  createUserSettingsStore,
  defaultUserSettings,
  LEGACY_V1_STORAGE_KEY,
  LEGACY_V2_STORAGE_KEY,
  LEGACY_V4_STORAGE_KEY,
  STORAGE_KEY,
} from './user-settings-store.js'

beforeEach(() => {
  localStorage.clear()
})

describe('a promotion record written before the counts were required', () => {
  it('keeps the counts and lists it did record when it migrates from v2', () => {
    localStorage.setItem(
      LEGACY_V2_STORAGE_KEY,
      JSON.stringify({
        version: 2,
        storage: {},
        migration: {
          promotion: {
            at: '2026-08-01T00:00:00.000Z',
            workspaceId: 'ws-a',
            ok: true,
            sourceWorkspaceId: 'ws-src',
            replicaSyncedAt: '2026-08-01T00:00:01.000Z',
            promotedCount: 4,
            shadowedPaths: ['a.md'],
            blobsMissing: ['m'],
            blobsFailed: ['f'],
          },
        },
        capabilities: {},
      }),
    )

    expect(createUserSettingsStore().load().migration.promotion).toEqual({
      at: '2026-08-01T00:00:00.000Z',
      workspaceId: 'ws-a',
      ok: true,
      sourceWorkspaceId: 'ws-src',
      replicaSyncedAt: '2026-08-01T00:00:01.000Z',
      promotedCount: 4,
      shadowedPaths: ['a.md'],
      blobsMissing: ['m'],
      blobsFailed: ['f'],
    })
  })
})

describe('an older payload beside a newer one that does not parse', () => {
  it('loads defaults rather than reaching past the invalid key to an older one', () => {
    localStorage.setItem(
      LEGACY_V4_STORAGE_KEY,
      JSON.stringify({ version: 4, storage: { notAField: true }, migration: {}, capabilities: {} }),
    )
    localStorage.setItem(
      LEGACY_V1_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        storage: {},
        migration: {},
        capabilities: { webMcpEnabled: true },
      }),
    )

    // The v1 settings may long since have been superseded by edits made under
    // v4; resurrecting them would undo what the person changed.
    expect(createUserSettingsStore().load()).toEqual(defaultUserSettings())
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull()
    expect(localStorage.getItem(LEGACY_V1_STORAGE_KEY)).not.toBeNull()
  })
})

describe('writing settings the schema refuses', () => {
  type SettingsWithToken = ReturnType<typeof defaultUserSettings> & {
    storage: { daemonToken?: string }
  }

  it('writes nothing, and keeps what was stored', () => {
    const store = createUserSettingsStore()
    store.update((current) => ({
      ...current,
      storage: { ...current.storage, daemonBaseUrl: 'http://127.0.0.1:3099' },
    }))
    const before = localStorage.getItem(STORAGE_KEY)

    store.update(
      (current) =>
        ({
          ...current,
          storage: { ...current.storage, daemonToken: 'secret' },
        }) as SettingsWithToken,
    )

    expect(localStorage.getItem(STORAGE_KEY)).toBe(before)
    expect(localStorage.getItem(STORAGE_KEY)).not.toContain('secret')
    expect(createUserSettingsStore().load().storage.daemonBaseUrl).toBe('http://127.0.0.1:3099')
  })
})
