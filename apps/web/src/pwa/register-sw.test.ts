import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setupSwRegistration } from './register-sw.js'

function fireWindowLoad(): void {
  window.dispatchEvent(new Event('load'))
}

describe('setupSwRegistration', () => {
  let originalServiceWorker: unknown

  beforeEach(() => {
    originalServiceWorker = Object.getOwnPropertyDescriptor(navigator, 'serviceWorker')
  })

  afterEach(() => {
    if (originalServiceWorker) {
      Object.defineProperty(navigator, 'serviceWorker', originalServiceWorker)
    }
    vi.restoreAllMocks()
  })

  it('registers the SW after window load when in production with serviceWorker support', async () => {
    Object.defineProperty(navigator, 'serviceWorker', { value: {}, configurable: true })
    const registerSW = vi.fn()
    const importRegister = vi.fn().mockResolvedValue({ registerSW })

    setupSwRegistration({ isProd: true, hasServiceWorker: true, importRegister })
    fireWindowLoad()
    // dynamic import resolution needs a microtask flush
    await Promise.resolve()
    await Promise.resolve()

    expect(importRegister).toHaveBeenCalledTimes(1)
    expect(registerSW).toHaveBeenCalledTimes(1)
    expect(registerSW.mock.calls[0][0]).toHaveProperty('onNeedRefresh')
  })

  it('registers immediately when the load event has already fired (readyState complete)', async () => {
    // The entry module graph contains top-level await (loro WASM init), so
    // module evaluation can finish AFTER window 'load' has fired — a
    // load-listener-only implementation would never register the SW.
    Object.defineProperty(navigator, 'serviceWorker', { value: {}, configurable: true })
    const registerSW = vi.fn()
    const importRegister = vi.fn().mockResolvedValue({ registerSW })

    expect(document.readyState).toBe('complete')
    setupSwRegistration({ isProd: true, hasServiceWorker: true, importRegister })
    // NO fireWindowLoad() — load already happened before setup ran.
    await Promise.resolve()
    await Promise.resolve()

    expect(importRegister).toHaveBeenCalledTimes(1)
    expect(registerSW).toHaveBeenCalledTimes(1)
  })

  it('does not attempt registration when serviceWorker is unsupported', async () => {
    const importRegister = vi.fn()

    expect(() =>
      setupSwRegistration({ isProd: true, hasServiceWorker: false, importRegister }),
    ).not.toThrow()
    fireWindowLoad()
    await Promise.resolve()

    expect(importRegister).not.toHaveBeenCalled()
  })

  it('does not register in dev mode even when serviceWorker is supported', async () => {
    Object.defineProperty(navigator, 'serviceWorker', { value: {}, configurable: true })
    const importRegister = vi.fn()

    setupSwRegistration({ isProd: false, hasServiceWorker: true, importRegister })
    fireWindowLoad()
    await Promise.resolve()

    expect(importRegister).not.toHaveBeenCalled()
  })

  it('does not leave an unhandled rejection when the dynamic import fails', async () => {
    Object.defineProperty(navigator, 'serviceWorker', { value: {}, configurable: true })
    const importRegister = vi.fn().mockRejectedValue(new Error('chunk load failed'))
    const unhandledRejections: unknown[] = []
    const onUnhandledRejection = (event: PromiseRejectionEvent): void => {
      unhandledRejections.push(event.reason)
    }
    window.addEventListener('unhandledrejection', onUnhandledRejection)

    try {
      setupSwRegistration({ isProd: true, hasServiceWorker: true, importRegister })
      fireWindowLoad()
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()

      expect(unhandledRejections).toEqual([])
    } finally {
      window.removeEventListener('unhandledrejection', onUnhandledRejection)
    }
  })
})
