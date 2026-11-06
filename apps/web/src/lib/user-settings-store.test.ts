import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createUserSettingsStore,
  defaultUserSettings,
  fitLeftBehind,
  LEGACY_V4_STORAGE_KEY,
  STORAGE_KEY,
  userSettingsSchema,
} from './user-settings-store.js'

describe('fitLeftBehind', () => {
  it('clips a list past the bound to what a strict settings write keeps', () => {
    const leftBehind = fitLeftBehind(Array.from({ length: 101 }, () => 'x'.repeat(600)))
    const settings = {
      ...defaultUserSettings(),
      migration: {
        promotion: {
          at: '2026-10-01T00:00:00.000Z',
          workspaceId: 'ws-a',
          ok: true as const,
          promotedCount: 1,
          shadowedPaths: [],
          blobsMissing: [],
          blobsFailed: [],
          leftBehind,
        },
      },
    }
    expect(userSettingsSchema.safeParse(settings).success).toBe(true)
    expect(leftBehind).toHaveLength(100)
  })

  it('drops an astral character the bound falls inside rather than keeping half of it', () => {
    // A reason quotes a document path, which may run past the bound with an
    // emoji straddling it.
    const reason = `${'x'.repeat(499)}\u{1F600}tail`
    expect(fitLeftBehind([reason])).toEqual(['x'.repeat(499)])
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
      storage: {
        daemonBaseUrl: 'http://127.0.0.1:3099',
        replicas: { 'ws-1': { daemonBaseUrl: 'http://127.0.0.1:3099', syncedAt: '2026-09-01' } },
      },
    })

    const reloaded = createUserSettingsStore()
    expect(reloaded.load().storage).toMatchObject({
      daemonBaseUrl: 'http://127.0.0.1:3099',
      replicas: { 'ws-1': { daemonBaseUrl: 'http://127.0.0.1:3099', syncedAt: '2026-09-01' } },
    })
  })

  it('update() applies fn to current settings and persists the result', () => {
    const store = createUserSettingsStore()
    store.update((current) => ({
      ...current,
      storage: { ...current.storage, daemonBaseUrl: 'http://127.0.0.1:3099' },
    }))

    expect(createUserSettingsStore().load().storage.daemonBaseUrl).toBe('http://127.0.0.1:3099')
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
        version: 5,
        storage: { daemonBaseUrl: hostile },
        migration: {},
        capabilities: {},
        appearance: { faviconStyle: 'dot' },
      }),
    )

    const loaded = createUserSettingsStore().load()
    expect(loaded.storage.daemonBaseUrl).toBeUndefined()
    // The whole payload is discarded, not just the offending field.
    expect(loaded.appearance?.faviconStyle).toBeUndefined()
  })

  it('accepts an http(s) base URL in an otherwise identical payload', () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        version: 5,
        storage: { daemonBaseUrl: 'http://127.0.0.1:3099' },
        migration: {},
        capabilities: {},
        appearance: { faviconStyle: 'dot' },
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

  it('never loads a daemonToken-shaped key, and the next write purges it from storage', () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        version: 5,
        storage: { daemonBaseUrl: 'http://127.0.0.1:3099', daemonToken: 'super-secret' },
        migration: {},
        capabilities: {},
      }),
    )
    const store = createUserSettingsStore()
    expect(JSON.stringify(store.load())).not.toContain('super-secret')
    expect(store.load().storage.daemonBaseUrl).toBe('http://127.0.0.1:3099')

    store.update((current) => current)

    expect(localStorage.getItem(STORAGE_KEY)).not.toContain('super-secret')
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
      // The origin binding: the result surface shows a stored result as
      // actionable only while connected to this same daemon.
      daemonBaseUrl: 'http://127.0.0.1:3099',
      workspaceId: 'ws-a',
      ok: true as const,
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
      daemonBaseUrl: 'http://127.0.0.1:3099',
      workspaceId: 'ws-a',
      ok: false as const,
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
      JSON.stringify({ version: 5, storage: {}, migration: {}, capabilities: {} }),
    )
    const settings = createUserSettingsStore().load()
    expect(settings.version).toBe(5)
    expect(settings.appearance?.faviconStyle).toBeUndefined()
  })

  it('rejects an unknown appearance value (falls back to defaults)', () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        version: 5,
        storage: {},
        migration: {},
        capabilities: {},
        appearance: { faviconStyle: 'sparkles' },
      }),
    )
    expect(createUserSettingsStore().load().appearance).toEqual({})
  })
})

describe('v4 -> v5 migration', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('a live payload still carrying a retired field loads without it', () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        version: 5,
        storage: { knownDaemonBaseUrls: ['http://127.0.0.1:3099'] },
        migration: {},
        capabilities: {},
      }),
    )
    expect(createUserSettingsStore().load().storage).toEqual({})
  })

  // A full v4 payload: the connection, the two dismissal stamps nothing has
  // read since the banners they belonged to went, a replica with its
  // frontier, a move's record, and the two optional sections.
  function writeV4(): void {
    localStorage.setItem(
      LEGACY_V4_STORAGE_KEY,
      JSON.stringify({
        version: 4,
        storage: {
          daemonBaseUrl: 'http://127.0.0.1:3099',
          dismissedPersistenceWarningAt: '2026-07-05T00:00:00.000Z',
          dismissedBetaBannerAt: '2026-07-06T00:00:00.000Z',
          replicas: {
            'ws-1': {
              daemonBaseUrl: 'http://127.0.0.1:3099',
              syncedAt: '2026-09-01T00:00:00Z',
              segment: 'team',
              syncedFrontier: 'AAEC',
            },
          },
        },
        migration: {
          promotion: {
            at: '2026-08-01T00:00:00.000Z',
            workspaceId: 'ws-a',
            ok: true,
            promotedCount: 2,
            shadowedPaths: [],
            blobsMissing: [],
            blobsFailed: [],
          },
        },
        capabilities: { webMcpEnabled: true },
        appearance: { faviconStyle: 'dot' },
      }),
    )
  }

  it('drops the two dismissal stamps and keeps everything else', () => {
    writeV4()
    const loaded = createUserSettingsStore().load()
    expect(loaded).toEqual({
      version: 5,
      storage: {
        daemonBaseUrl: 'http://127.0.0.1:3099',
        replicas: {
          'ws-1': {
            daemonBaseUrl: 'http://127.0.0.1:3099',
            syncedAt: '2026-09-01T00:00:00Z',
            segment: 'team',
            syncedFrontier: 'AAEC',
          },
        },
      },
      migration: {
        promotion: {
          at: '2026-08-01T00:00:00.000Z',
          workspaceId: 'ws-a',
          ok: true,
          promotedCount: 2,
          shadowedPaths: [],
          blobsMissing: [],
          blobsFailed: [],
        },
      },
      capabilities: { webMcpEnabled: true },
      appearance: { faviconStyle: 'dot' },
    })
  })

  it('persists the migrated payload under the current key and removes the v4 one', () => {
    writeV4()
    createUserSettingsStore().load()
    expect(localStorage.getItem(LEGACY_V4_STORAGE_KEY)).toBeNull()
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null').version).toBe(5)
  })

  it('a current payload wins and a stale v4 key cannot resurrect', () => {
    writeV4()
    createUserSettingsStore().save({
      ...defaultUserSettings(),
      storage: { daemonBaseUrl: 'http://127.0.0.1:4321' },
    })
    expect(createUserSettingsStore().load().storage.daemonBaseUrl).toBe('http://127.0.0.1:4321')
  })

  it('reset() clears the un-migrated v4 key too, so nothing resurrects', () => {
    writeV4()
    const store = createUserSettingsStore()
    store.reset()
    expect(store.load()).toEqual(defaultUserSettings())
  })

  it('a live payload still carrying a dismissal stamp loads without it', () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        version: 5,
        storage: { dismissedBetaBannerAt: '2026-07-06T00:00:00.000Z' },
        migration: {},
        capabilities: {},
      }),
    )
    expect(createUserSettingsStore().load().storage).toEqual({})
  })
})

describe('a payload older than the one migration left', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  // Spelled as literals: the keys are no longer named anywhere in the store,
  // which is the point — a v1, v2 or v3 payload is not read at all.
  it.each([
    ['whiteboard:user-settings:v1', 1],
    ['whiteboard:user-settings:v2', 2],
    ['whiteboard:user-settings:v3', 3],
  ])('loads defaults over a payload under %s and writes nothing', (key, version) => {
    localStorage.setItem(
      key,
      JSON.stringify({
        version,
        storage: { daemonBaseUrl: 'http://127.0.0.1:3099' },
        migration: {},
        capabilities: { webMcpEnabled: true },
      }),
    )
    expect(createUserSettingsStore().load()).toEqual(defaultUserSettings())
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull()
  })
})
