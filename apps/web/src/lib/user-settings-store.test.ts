import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createUserSettingsStore,
  defaultUserSettings,
  LEGACY_V1_STORAGE_KEY,
  STORAGE_KEY,
} from './user-settings-store.js'

describe('knownDaemonBaseUrls bound', () => {
  it('an oversized stored array fails validation and load falls back to defaults', () => {
    localStorage.clear()
    const oversized = Array.from({ length: 6 }, (_, i) => `http://127.0.0.1:${3099 + i}`)
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ version: 2, storage: { knownDaemonBaseUrls: oversized } }),
    )
    const store = createUserSettingsStore()
    // Consistent with the store's existing invalid-value semantics (e.g. a
    // non-http daemonBaseUrl): safeParse fails and defaults win, so
    // discovery can never fan out over an unbounded tampered list.
    expect(store.load().storage.knownDaemonBaseUrls).toBeUndefined()
  })
})

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
      storage: { daemonBaseUrl: 'http://127.0.0.1:3099', lastConnectedWorkspaceId: 'ws-1' },
    })

    const reloaded = createUserSettingsStore()
    expect(reloaded.load().storage).toMatchObject({
      daemonBaseUrl: 'http://127.0.0.1:3099',
      lastConnectedWorkspaceId: 'ws-1',
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

  it('persists daemonBaseUrl, lastConnectedWorkspaceId and lastConnectedPath (reconnect target)', () => {
    const store = createUserSettingsStore()
    store.update((current) => ({
      ...current,
      storage: {
        ...current.storage,
        daemonBaseUrl: 'http://127.0.0.1:3099',
        lastConnectedWorkspaceId: 'w1',
        lastConnectedPath: 'main',
      },
    }))

    const reloaded = createUserSettingsStore().load()
    expect(reloaded.storage.daemonBaseUrl).toBe('http://127.0.0.1:3099')
    expect(reloaded.storage.lastConnectedWorkspaceId).toBe('w1')
    expect(reloaded.storage.lastConnectedPath).toBe('main')
  })

  // The stored base URL is rendered into an `href`. Anything that can write
  // localStorage could otherwise plant a `javascript:` URL and turn a link
  // click into script execution, so the schema rejects it and the caller falls
  // back to defaults rather than trusting what it read.
  it.each([
    'javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'not a url',
  ])('rejects a stored daemonBaseUrl that is not http(s): %s', (hostile) => {
    // Everything else in this payload is valid, so only the URL constraint
    // can be what rejects it — otherwise the test would pass whether or not
    // the constraint exists.
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        version: 2,
        storage: { daemonBaseUrl: hostile, lastConnectedWorkspaceId: 'w1' },
        migration: {},
        capabilities: {},
      }),
    )

    const loaded = createUserSettingsStore().load()
    expect(loaded.storage.daemonBaseUrl).toBeUndefined()
    // The whole payload is discarded, not just the offending field.
    expect(loaded.storage.lastConnectedWorkspaceId).toBeUndefined()
  })

  it('accepts an http(s) base URL in an otherwise identical payload', () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        version: 2,
        storage: { daemonBaseUrl: 'http://127.0.0.1:3099', lastConnectedWorkspaceId: 'w1' },
        migration: {},
        capabilities: {},
      }),
    )

    expect(createUserSettingsStore().load().storage.daemonBaseUrl).toBe('http://127.0.0.1:3099')
  })

  it('reset() clears stored settings back to defaults', () => {
    const store = createUserSettingsStore()
    store.save({
      ...defaultUserSettings(),
      storage: { daemonBaseUrl: 'http://127.0.0.1:3099' },
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
        version: 2,
        storage: { daemonBaseUrl: 'http://127.0.0.1:3099', daemonToken: 'super-secret' },
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

describe('promotion result persistence', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  // The promote UI's result surface is persistent (never toast-only): the
  // outcome must survive navigating away from Settings and back, and a full
  // reload — so it lives here, beside the other browser-to-daemon migration
  // state.
  it('round-trips a success result under migration.promotion', () => {
    const result = {
      at: '2026-08-28T12:00:00.000Z',
      workspaceId: 'ws-a',
      ok: true,
      promotedCount: 3,
      shadowedPaths: ['contested'],
      blobsMissing: [],
      blobsFailed: [],
    }
    createUserSettingsStore().update((current) => ({
      ...current,
      migration: { ...current.migration, promotion: result },
    }))
    expect(createUserSettingsStore().load().migration.promotion).toEqual(result)
  })

  it('round-trips a failure result carrying the reason', () => {
    const result = {
      at: '2026-08-28T12:00:00.000Z',
      workspaceId: 'ws-a',
      ok: false,
      reason: 'Could not reach the daemon (network error).',
    }
    createUserSettingsStore().update((current) => ({
      ...current,
      migration: { ...current.migration, promotion: result },
    }))
    expect(createUserSettingsStore().load().migration.promotion).toEqual(result)
  })

  it('parses a stored payload from before the promotion field existed', () => {
    const store = createUserSettingsStore()
    store.save(defaultUserSettings())
    expect(createUserSettingsStore().load().migration.promotion).toBeUndefined()
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
        version: 2,
        storage: { daemonBaseUrl: 'http://127.0.0.1:3099', lastConnectedPath: 'abc' },
        migration: {},
        capabilities: {},
      }),
    )
    const store = createUserSettingsStore()
    expect(store.load().storage.daemonBaseUrl).toBe('http://127.0.0.1:3099')
    expect(store.load().storage.lastConnectedPath).toBe('abc')
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

describe('appearance settings', () => {
  it('round-trips faviconStyle', () => {
    const store = createUserSettingsStore()
    store.update((s) => ({ ...s, appearance: { faviconStyle: 'dot' } }))
    expect(store.load().appearance?.faviconStyle).toBe('dot')
  })

  it('parses a stored payload from before the appearance section existed', () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ version: 2, storage: {}, migration: {}, capabilities: {} }),
    )
    const settings = createUserSettingsStore().load()
    expect(settings.version).toBe(2)
    expect(settings.appearance?.faviconStyle).toBeUndefined()
  })

  it('rejects an unknown appearance value (falls back to defaults)', () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        version: 2,
        storage: {},
        migration: {},
        capabilities: {},
        appearance: { faviconStyle: 'sparkles' },
      }),
    )
    expect(createUserSettingsStore().load().appearance).toEqual({})
  })
})

describe('v1 -> v2 migration', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  // A full v1 payload: every field a real reader could be holding.
  function writeV1(storage: Record<string, unknown> = {}): void {
    localStorage.setItem(
      LEGACY_V1_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        storage: {
          localDaemonBaseUrl: 'http://127.0.0.1:3099',
          knownDaemonBaseUrls: ['http://127.0.0.1:3099'],
          dismissedDaemonBaseUrls: ['http://127.0.0.1:4000'],
          lastConnectedWorkspaceId: 'ws-1',
          lastConnectedPath: 'notes/plan',
          dismissedPersistenceWarningAt: '2026-07-05T00:00:00.000Z',
          dismissedBetaBannerAt: '2026-07-06T00:00:00.000Z',
          dismissedDaemonCtaAt: '2026-07-07T00:00:00.000Z',
          dismissedDaemonCtaInstanceId: 'inst-1',
          ...storage,
        },
        migration: { browserToDaemon: { lastImportedDocumentId: 'doc-1' } },
        capabilities: { webMcpEnabled: true, webMcpMaxTier: 2 },
        appearance: { faviconStyle: 'dot' },
      }),
    )
  }

  it('carries the daemon connection across under its new name', () => {
    writeV1()
    expect(createUserSettingsStore().load().storage.daemonBaseUrl).toBe('http://127.0.0.1:3099')
  })

  // The whole point of the increment: renaming in place would have discarded
  // ALL of this, not just the daemon URL, because the schema is `.strict()`
  // and load() falls back to defaults on any parse failure.
  it('carries every other stored field across unchanged', () => {
    writeV1()
    const loaded = createUserSettingsStore().load()
    expect(loaded.storage).toMatchObject({
      knownDaemonBaseUrls: ['http://127.0.0.1:3099'],
      dismissedDaemonBaseUrls: ['http://127.0.0.1:4000'],
      lastConnectedWorkspaceId: 'ws-1',
      lastConnectedPath: 'notes/plan',
      dismissedPersistenceWarningAt: '2026-07-05T00:00:00.000Z',
      dismissedBetaBannerAt: '2026-07-06T00:00:00.000Z',
      dismissedDaemonCtaAt: '2026-07-07T00:00:00.000Z',
      dismissedDaemonCtaInstanceId: 'inst-1',
    })
    expect(loaded.migration).toEqual({ browserToDaemon: { lastImportedDocumentId: 'doc-1' } })
    expect(loaded.capabilities).toEqual({ webMcpEnabled: true, webMcpMaxTier: 2 })
    expect(loaded.appearance).toEqual({ faviconStyle: 'dot' })
  })

  // Both are fields nothing read or wrote. A dead field does not need a better
  // name, so the migration drops them rather than carrying them under one.
  it('drops the two dead fields rather than renaming them', () => {
    writeV1({ preferredProvider: 'local-daemon', lastBrowserCanvasId: 'canvas-1' })
    const loaded = createUserSettingsStore().load()
    expect(loaded.storage).not.toHaveProperty('preferredProvider')
    expect(loaded.storage).not.toHaveProperty('lastBrowserCanvasId')
    // and their presence must not fail the parse and cost the rest
    expect(loaded.storage.daemonBaseUrl).toBe('http://127.0.0.1:3099')
  })

  it('persists the migrated payload under the v2 key and removes the v1 one', () => {
    writeV1()
    createUserSettingsStore().load()
    expect(localStorage.getItem(LEGACY_V1_STORAGE_KEY)).toBeNull()
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null')
    expect(stored.version).toBe(2)
    expect(stored.storage.daemonBaseUrl).toBe('http://127.0.0.1:3099')
  })

  it('a v2 payload wins and no migration runs, so a stale v1 key cannot resurrect', () => {
    writeV1()
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        version: 2,
        storage: { daemonBaseUrl: 'http://127.0.0.1:4321' },
        migration: {},
        capabilities: {},
      }),
    )
    expect(createUserSettingsStore().load().storage.daemonBaseUrl).toBe('http://127.0.0.1:4321')
    // untouched, because the v2 key answered
    expect(localStorage.getItem(LEGACY_V1_STORAGE_KEY)).not.toBeNull()
  })

  // The v1 schema was `.strict()` for exactly this reason; the migration must
  // not become the hole that lets a token-shaped key through.
  it('refuses a v1 payload carrying an unknown token-shaped key', () => {
    localStorage.setItem(
      LEGACY_V1_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        storage: { localDaemonBaseUrl: 'http://127.0.0.1:3099', daemonToken: 'super-secret' },
        migration: {},
        capabilities: {},
      }),
    )
    expect(createUserSettingsStore().load()).toEqual(defaultUserSettings())
  })

  it('reset() clears the un-migrated v1 key too, so nothing resurrects', () => {
    writeV1()
    const store = createUserSettingsStore()
    store.reset()
    expect(store.load()).toEqual(defaultUserSettings())
  })

  it('a v1 payload with no daemon connection migrates without inventing one', () => {
    localStorage.setItem(
      LEGACY_V1_STORAGE_KEY,
      JSON.stringify({ version: 1, storage: {}, migration: {}, capabilities: {} }),
    )
    const loaded = createUserSettingsStore().load()
    expect(loaded.storage).not.toHaveProperty('daemonBaseUrl')
    expect(loaded.version).toBe(2)
  })
})
