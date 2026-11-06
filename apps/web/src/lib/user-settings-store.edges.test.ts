/**
 * What the store does at the edges its main suite does not walk: a promotion
 * record's reasons across a reload, a v4 payload that fails to parse, and a
 * write the schema refuses.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import {
  createUserSettingsStore,
  defaultUserSettings,
  LEGACY_V4_STORAGE_KEY,
  STORAGE_KEY,
} from './user-settings-store.js'

beforeEach(() => {
  localStorage.clear()
})

describe('a promotion record that says what it left behind', () => {
  const record = {
    at: '2026-10-01T00:00:00.000Z',
    workspaceId: 'ws-a',
    ok: true as const,
    promotedCount: 1,
    shadowedPaths: [],
    blobsMissing: [],
    blobsFailed: [],
  }

  it('keeps the reasons across a save and a fresh load', () => {
    const leftBehind = ['1 saved version did not reach the daemon']
    createUserSettingsStore().update((current) => ({
      ...current,
      migration: { promotion: { ...record, leftBehind } },
    }))
    expect(createUserSettingsStore().load().migration.promotion).toEqual({
      ...record,
      leftBehind,
    })
  })

  it('still loads a record stored before the reasons were kept', () => {
    createUserSettingsStore().update((current) => ({
      ...current,
      migration: { promotion: record },
    }))
    expect(createUserSettingsStore().load().migration.promotion).toEqual(record)
  })
})

describe('a v4 payload that does not parse', () => {
  it('loads defaults and writes nothing, keeping the payload where it was', () => {
    localStorage.setItem(
      LEGACY_V4_STORAGE_KEY,
      JSON.stringify({ version: 4, storage: { notAField: true }, migration: {}, capabilities: {} }),
    )

    expect(createUserSettingsStore().load()).toEqual(defaultUserSettings())
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull()
    expect(localStorage.getItem(LEGACY_V4_STORAGE_KEY)).not.toBeNull()
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
