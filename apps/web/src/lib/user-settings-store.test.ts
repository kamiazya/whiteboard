import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createUserSettingsStore, defaultUserSettings, STORAGE_KEY } from './user-settings-store.js'

describe('createUserSettingsStore', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('load() returns defaults when nothing is stored', () => {
    const store = createUserSettingsStore()
    expect(store.load()).toEqual(defaultUserSettings())
  })

  it('save() then a fresh instance load() returns the persisted value (reload simulation)', () => {
    const store = createUserSettingsStore()
    store.save({
      ...defaultUserSettings(),
      storage: { preferredProvider: 'browser-local', lastBrowserLocalCanvasId: 'canvas-1' },
    })

    const reloaded = createUserSettingsStore()
    expect(reloaded.load().storage).toMatchObject({
      preferredProvider: 'browser-local',
      lastBrowserLocalCanvasId: 'canvas-1',
    })
  })

  it('update() applies fn to current settings and persists the result', () => {
    const store = createUserSettingsStore()
    store.update((current) => ({
      ...current,
      storage: { ...current.storage, dismissedPersistenceWarningAt: '2026-07-05T00:00:00.000Z' },
    }))

    expect(createUserSettingsStore().load().storage.dismissedPersistenceWarningAt).toBe(
      '2026-07-05T00:00:00.000Z',
    )
  })

  it('persists dismissedDaemonCtaAt and dismissedDaemonCtaInstanceId (daemon CTA banner dismissal)', () => {
    const store = createUserSettingsStore()
    store.update((current) => ({
      ...current,
      storage: {
        ...current.storage,
        dismissedDaemonCtaAt: '2026-07-05T00:00:00.000Z',
        dismissedDaemonCtaInstanceId: 'instance-1',
      },
    }))

    const reloaded = createUserSettingsStore().load()
    expect(reloaded.storage.dismissedDaemonCtaAt).toBe('2026-07-05T00:00:00.000Z')
    expect(reloaded.storage.dismissedDaemonCtaInstanceId).toBe('instance-1')
  })

  it('reset() clears stored settings back to defaults', () => {
    const store = createUserSettingsStore()
    store.save({
      ...defaultUserSettings(),
      storage: { preferredProvider: 'local-daemon' },
    })
    store.reset()

    expect(createUserSettingsStore().load()).toEqual(defaultUserSettings())
  })

  it('falls back to defaults when stored JSON is corrupted', () => {
    localStorage.setItem(STORAGE_KEY, '{not valid json')
    const store = createUserSettingsStore()
    expect(store.load()).toEqual(defaultUserSettings())
  })

  it('falls back to defaults when stored version is unknown', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 999, storage: {} }))
    const store = createUserSettingsStore()
    expect(store.load()).toEqual(defaultUserSettings())
  })

  it('rejects a stored payload carrying a daemonToken-shaped key and falls back to defaults', () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        version: 1,
        storage: { preferredProvider: 'browser-local', daemonToken: 'super-secret' },
        migration: {},
        capabilities: {},
      }),
    )
    const store = createUserSettingsStore()
    expect(store.load()).toEqual(defaultUserSettings())
  })

  it('does not persist an update() result that injects an unknown token-shaped key', () => {
    const store = createUserSettingsStore()
    type SettingsWithToken = ReturnType<typeof defaultUserSettings> & {
      storage: { daemonToken?: string }
    }
    store.update(
      (current) =>
        ({
          ...current,
          storage: { ...current.storage, daemonToken: 'x' },
        }) as SettingsWithToken,
    )

    expect(createUserSettingsStore().load()).toEqual(defaultUserSettings())
  })
})

describe('createUserSettingsStore — beta banner dismissal', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('persists dismissedBetaBannerAt via update() and survives a fresh instance (reload simulation)', () => {
    const store = createUserSettingsStore()
    store.update((current) => ({
      ...current,
      storage: { ...current.storage, dismissedBetaBannerAt: '2026-07-05T00:00:00.000Z' },
    }))

    expect(createUserSettingsStore().load().storage.dismissedBetaBannerAt).toBe(
      '2026-07-05T00:00:00.000Z',
    )
  })

  it('preserves a pre-beta-banner payload (no dismissedBetaBannerAt) — adding an optional field is backward-compatible', () => {
    // A settings payload written before dismissedBetaBannerAt existed must keep
    // loading intact: adding an optional field must NOT bump the key/version and
    // must NOT discard the user's existing settings.
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        version: 1,
        storage: { preferredProvider: 'local-daemon', lastBrowserLocalCanvasId: 'abc' },
        migration: {},
        capabilities: {},
      }),
    )
    const store = createUserSettingsStore()
    expect(store.load().storage.preferredProvider).toBe('local-daemon')
    expect(store.load().storage.lastBrowserLocalCanvasId).toBe('abc')
    expect(store.load().storage.dismissedBetaBannerAt).toBeUndefined()
  })
})

describe('createUserSettingsStore — blocked storage (SecurityError)', () => {
  // Browsers can throw from localStorage access itself when storage is blocked
  // by privacy settings. The store's contract is "never throws".
  it('load() returns defaults when localStorage.getItem throws', () => {
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError')
    })
    try {
      expect(createUserSettingsStore().load()).toEqual(defaultUserSettings())
    } finally {
      spy.mockRestore()
    }
  })

  it('save() and reset() do not throw when localStorage writes throw', () => {
    const setSpy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError')
    })
    const removeSpy = vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError')
    })
    try {
      const store = createUserSettingsStore()
      expect(() => store.save(defaultUserSettings())).not.toThrow()
      expect(() => store.reset()).not.toThrow()
    } finally {
      setSpy.mockRestore()
      removeSpy.mockRestore()
    }
  })
})
