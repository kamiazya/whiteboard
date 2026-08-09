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

  it('defers registration to the load event while the document is still loading', async () => {
    // jsdom reports readyState 'complete' by default, which would exercise
    // the immediate path — force 'loading' so this test actually covers the
    // load-listener branch.
    const readyStateSpy = vi.spyOn(document, 'readyState', 'get').mockReturnValue('loading')
    Object.defineProperty(navigator, 'serviceWorker', { value: {}, configurable: true })
    const registerSW = vi.fn()
    const importRegister = vi.fn().mockResolvedValue({ registerSW })

    setupSwRegistration({
      isProd: true,
      hasServiceWorker: true,
      isDaemonServed: false,
      importRegister,
    })
    // Not yet — registration must wait for 'load'.
    expect(importRegister).not.toHaveBeenCalled()

    fireWindowLoad()
    // dynamic import resolution needs a microtask flush
    await Promise.resolve()
    await Promise.resolve()

    expect(importRegister).toHaveBeenCalledTimes(1)
    expect(registerSW).toHaveBeenCalledTimes(1)
    expect(registerSW.mock.calls[0][0]).toHaveProperty('onNeedRefresh')
    readyStateSpy.mockRestore()
  })

  it('registers immediately when the load event has already fired (readyState complete)', async () => {
    // The entry module graph contains top-level await (loro WASM init), so
    // module evaluation can finish AFTER window 'load' has fired — a
    // load-listener-only implementation would never register the SW.
    Object.defineProperty(navigator, 'serviceWorker', { value: {}, configurable: true })
    const registerSW = vi.fn()
    const importRegister = vi.fn().mockResolvedValue({ registerSW })

    expect(document.readyState).toBe('complete')
    setupSwRegistration({
      isProd: true,
      hasServiceWorker: true,
      isDaemonServed: false,
      importRegister,
    })
    // NO fireWindowLoad() — load already happened before setup ran.
    await Promise.resolve()
    await Promise.resolve()

    expect(importRegister).toHaveBeenCalledTimes(1)
    expect(registerSW).toHaveBeenCalledTimes(1)
  })

  it('does not attempt registration when serviceWorker is unsupported', async () => {
    const importRegister = vi.fn()

    expect(() =>
      setupSwRegistration({
        isProd: true,
        hasServiceWorker: false,
        isDaemonServed: false,
        importRegister,
      }),
    ).not.toThrow()
    fireWindowLoad()
    await Promise.resolve()

    expect(importRegister).not.toHaveBeenCalled()
  })

  it('does not register in dev mode even when serviceWorker is supported', async () => {
    Object.defineProperty(navigator, 'serviceWorker', { value: {}, configurable: true })
    const importRegister = vi.fn()

    setupSwRegistration({
      isProd: false,
      hasServiceWorker: true,
      isDaemonServed: false,
      importRegister,
    })
    fireWindowLoad()
    await Promise.resolve()

    expect(importRegister).not.toHaveBeenCalled()
  })

  // The local daemon serves one page (/pair) and redirects every other path
  // to the hosted app, so `/sw.js` there answers 302 to a different origin.
  // Registering would make the browser fetch the hosted app's HTML as a
  // worker script — a request that can never succeed and, under the page's
  // CSP, never settles either.
  it('does not register on a daemon-served page', async () => {
    Object.defineProperty(navigator, 'serviceWorker', { value: {}, configurable: true })
    const importRegister = vi.fn()

    setupSwRegistration({
      isProd: true,
      hasServiceWorker: true,
      isDaemonServed: true,
      importRegister,
    })
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
      setupSwRegistration({
        isProd: true,
        hasServiceWorker: true,
        isDaemonServed: false,
        importRegister,
      })
      fireWindowLoad()
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()

      expect(unhandledRejections).toEqual([])
    } finally {
      window.removeEventListener('unhandledrejection', onUnhandledRejection)
    }
  })

  it('passes both onNeedRefresh and onRegisteredSW to registerSW', async () => {
    Object.defineProperty(navigator, 'serviceWorker', { value: {}, configurable: true })
    const registerSW = vi.fn()
    const importRegister = vi.fn().mockResolvedValue({ registerSW })

    setupSwRegistration({
      isProd: true,
      hasServiceWorker: true,
      isDaemonServed: false,
      importRegister,
    })
    await Promise.resolve()
    await Promise.resolve()

    expect(registerSW).toHaveBeenCalledTimes(1)
    expect(registerSW.mock.calls[0][0]).toHaveProperty('onNeedRefresh')
    expect(registerSW.mock.calls[0][0]).toHaveProperty('onRegisteredSW')
    expect(typeof registerSW.mock.calls[0][0].onRegisteredSW).toBe('function')
  })

  it('starts the update scheduler when onRegisteredSW is invoked with a registration', async () => {
    Object.defineProperty(navigator, 'serviceWorker', { value: {}, configurable: true })
    const registerSW = vi.fn()
    const importRegister = vi.fn().mockResolvedValue({ registerSW })

    setupSwRegistration({
      isProd: true,
      hasServiceWorker: true,
      isDaemonServed: false,
      importRegister,
    })
    await Promise.resolve()
    await Promise.resolve()

    const { onRegisteredSW } = registerSW.mock.calls[0][0]
    const update = vi.fn().mockResolvedValue(undefined)
    const fakeRegistration = { update } as unknown as ServiceWorkerRegistration

    vi.useFakeTimers()
    try {
      onRegisteredSW('/sw.js', fakeRegistration)
      // dynamic import of the scheduler module needs microtask flushes
      await vi.waitFor(() => {
        vi.advanceTimersByTime(60 * 60 * 1000)
        expect(update).toHaveBeenCalled()
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not leave an unhandled rejection when the update-scheduler dynamic import fails', async () => {
    Object.defineProperty(navigator, 'serviceWorker', { value: {}, configurable: true })
    const registerSW = vi.fn()
    const importRegister = vi.fn().mockResolvedValue({ registerSW })
    const unhandledRejections: unknown[] = []
    const onUnhandledRejection = (event: PromiseRejectionEvent): void => {
      unhandledRejections.push(event.reason)
    }
    window.addEventListener('unhandledrejection', onUnhandledRejection)

    try {
      setupSwRegistration({
        isProd: true,
        hasServiceWorker: true,
        isDaemonServed: false,
        importRegister,
      })
      await Promise.resolve()
      await Promise.resolve()

      const { onRegisteredSW } = registerSW.mock.calls[0][0]
      const fakeRegistration = {
        update: vi.fn().mockResolvedValue(undefined),
      } as unknown as ServiceWorkerRegistration

      vi.doMock('./sw-update-scheduler.js', () => {
        throw new Error('chunk load failed')
      })

      expect(() => onRegisteredSW('/sw.js', fakeRegistration)).not.toThrow()
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()

      expect(unhandledRejections).toEqual([])
    } finally {
      window.removeEventListener('unhandledrejection', onUnhandledRejection)
      vi.doUnmock('./sw-update-scheduler.js')
    }
  })

  it('does not throw and schedules nothing when onRegisteredSW is invoked with no registration', async () => {
    Object.defineProperty(navigator, 'serviceWorker', { value: {}, configurable: true })
    const registerSW = vi.fn()
    const importRegister = vi.fn().mockResolvedValue({ registerSW })

    setupSwRegistration({
      isProd: true,
      hasServiceWorker: true,
      isDaemonServed: false,
      importRegister,
    })
    await Promise.resolve()
    await Promise.resolve()

    const { onRegisteredSW } = registerSW.mock.calls[0][0]

    expect(() => onRegisteredSW('/sw.js', undefined)).not.toThrow()
  })
})
