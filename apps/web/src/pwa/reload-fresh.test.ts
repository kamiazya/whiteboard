// @vitest-environment node
/**
 * The app's own Reload has to do more than the browser's.
 *
 * `apps/web` registers a Workbox worker with `registerType: 'prompt'`, so a
 * plain `location.reload()` re-runs the SAME cached bundle — the worker keeps
 * serving it until something calls `skipWaiting`. That is exactly the state
 * the error screen is reached in when the page is running chunks that no
 * longer agree with each other, and offering a reload that cannot change the
 * bundle is offering a button that does nothing.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { reloadFresh } from './reload-fresh.js'

interface Recorder {
  unregistered: number
  deletedCaches: string[]
  reloaded: number
}

function install(overrides: { serviceWorker?: boolean; caches?: boolean } = {}): Recorder {
  const rec: Recorder = { unregistered: 0, deletedCaches: [], reloaded: 0 }
  if (overrides.serviceWorker !== false) {
    vi.stubGlobal('navigator', {
      ...globalThis.navigator,
      serviceWorker: {
        getRegistrations: () =>
          Promise.resolve([
            {
              unregister: () => {
                rec.unregistered += 1
                return Promise.resolve(true)
              },
            },
          ]),
      },
    })
  } else {
    vi.stubGlobal('navigator', { ...globalThis.navigator, serviceWorker: undefined })
  }
  if (overrides.caches !== false) {
    vi.stubGlobal('caches', {
      keys: () => Promise.resolve(['workbox-precache', 'assets']),
      delete: (key: string) => {
        rec.deletedCaches.push(key)
        return Promise.resolve(true)
      },
    })
  } else {
    vi.stubGlobal('caches', undefined)
  }
  return rec
}

afterEach(() => vi.unstubAllGlobals())

describe('reloadFresh', () => {
  it('drops every worker and every cache before reloading', async () => {
    const rec = install()
    await reloadFresh(() => {
      rec.reloaded += 1
    })
    expect(rec).toEqual({
      unregistered: 1,
      deletedCaches: ['workbox-precache', 'assets'],
      reloaded: 1,
    })
  })

  it('still reloads where there is no worker and no cache API', async () => {
    // A private window, an unsupported browser, or the dev server. The button
    // must not become a no-op just because the clearing has nothing to clear.
    const rec = install({ serviceWorker: false, caches: false })
    await reloadFresh(() => {
      rec.reloaded += 1
    })
    expect(rec.reloaded).toBe(1)
  })

  it('reloads even when clearing THROWS', async () => {
    // Storage access can throw outright (blocked site data), and a reload the
    // user cannot reach is worse than a reload that skipped its cleaning.
    vi.stubGlobal('navigator', {
      ...globalThis.navigator,
      serviceWorker: {
        getRegistrations: () => Promise.reject(new Error('site data blocked')),
      },
    })
    vi.stubGlobal('caches', undefined)
    let reloaded = 0
    await reloadFresh(() => {
      reloaded += 1
    })
    expect(reloaded).toBe(1)
  })
})
