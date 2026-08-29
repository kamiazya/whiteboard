/**
 * The boot chain's degradation invariant: a `resolveBrowserWorkspaceId`
 * rejection must never block `renderApp`, never escape as an unhandled
 * rejection, and must leave `getBrowserWorkspaceId()` throwing a cause-
 * carrying message a consumer's existing local error isolation can read.
 */
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { startBootSequence } from './boot.js'
import {
  getBrowserWorkspaceId,
  resetBrowserWorkspaceIdForTests,
  resolveBrowserWorkspaceId,
  setBrowserWorkspaceIdForTests,
} from './lib/browser-workspace-id.js'

const REAL_DB_NAME = 'whiteboard-boot-test'

async function clearDb(): Promise<void> {
  return new Promise((resolve) => {
    const req = indexedDB.deleteDatabase(REAL_DB_NAME)
    req.onsuccess = () => resolve()
    req.onerror = () => resolve()
  })
}

function rootEl(): HTMLElement {
  const el = document.createElement('div')
  document.body.appendChild(el)
  return el
}

/**
 * A connection at an old version with no `onversionchange` handler — the
 * "stale tab" `openWhiteboardDb`'s `onblocked` branch (browser-idb.ts:531-533)
 * exists for. Opening the real `whiteboard` schema at the current DB_VERSION
 * against this database then rejects instead of hanging.
 */
async function openStubbornAtOldVersion(dbName: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(dbName, 1)
    req.onupgradeneeded = () => {}
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

describe('startBootSequence — resolver rejection does not block render', () => {
  beforeEach(async () => {
    resetBrowserWorkspaceIdForTests()
    await clearDb()
  })
  afterEach(async () => {
    resetBrowserWorkspaceIdForTests()
    await clearDb()
  })

  it('settles, renders, and records the cause without an unhandled rejection, then recovers on retry', async () => {
    let unhandled: unknown = null
    const onUnhandled = (event: PromiseRejectionEvent) => {
      unhandled = event.reason
    }
    window.addEventListener('unhandledrejection', onUnhandled)

    // A real blocked open, through the REAL resolveBrowserWorkspaceId — not a
    // double that bypasses it — so the cause it caches is the one this
    // asserts on afterward, the same way production would reach it.
    const stubborn = await openStubbornAtOldVersion(REAL_DB_NAME)
    let rendered = false

    try {
      await startBootSequence({
        rootEl: rootEl(),
        resolveWorkspaceId: () => resolveBrowserWorkspaceId(REAL_DB_NAME),
        loadFont: async () => undefined,
        dismissSplash: async () => undefined,
        render: () => {
          rendered = true
        },
      })
      // Give a real unhandled rejection a turn to surface, if one would.
      await new Promise((resolve) => setTimeout(resolve, 0))

      expect(rendered).toBe(true)
      expect(unhandled).toBeNull()

      // The FAILED state's message carries the cause, and reads differently
      // from the unresolved-state message.
      expect(() => getBrowserWorkspaceId()).toThrow(/browser workspace unavailable/)
      expect(() => getBrowserWorkspaceId()).toThrow(/another tab/i)

      // A consumer-shaped flow: an accessor read wrapped the way
      // workspace-content.ts's `.open(...).catch(() => null)` wraps it lands
      // in the null branch instead of crashing the caller.
      const consumerResult = await Promise.resolve()
        .then(() => getBrowserWorkspaceId())
        .catch(() => null)
      expect(consumerResult).toBeNull()
    } finally {
      window.removeEventListener('unhandledrejection', onUnhandled)
      stubborn.close()
    }

    // Retryable: a later resolve against a database the stale tab no longer
    // holds recovers, rather than replaying the cached rejection.
    const recovered = await resolveBrowserWorkspaceId(REAL_DB_NAME)
    expect(recovered).toMatch(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/)
    expect(getBrowserWorkspaceId()).toBe(recovered)
  })

  it('the unresolved-state message is distinct from the failed-state message', () => {
    expect(() => getBrowserWorkspaceId()).toThrow(/resolveBrowserWorkspaceId/)
    expect(() => getBrowserWorkspaceId()).not.toThrow(/browser workspace unavailable/)
  })

  it('a resolved id (the production success path) survives an unrelated boot with no resolver override', async () => {
    setBrowserWorkspaceIdForTests('01ARZ3NDEKTSV4RRFFQ69G5FAV')
    let rendered = false
    await startBootSequence({
      rootEl: rootEl(),
      resolveWorkspaceId: async () => getBrowserWorkspaceId(),
      loadFont: async () => undefined,
      dismissSplash: async () => undefined,
      render: () => {
        rendered = true
      },
    })
    expect(rendered).toBe(true)
    expect(getBrowserWorkspaceId()).toBe('01ARZ3NDEKTSV4RRFFQ69G5FAV')
  })
})
