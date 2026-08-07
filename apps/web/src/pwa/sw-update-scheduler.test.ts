import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { startSwUpdateScheduler, SW_UPDATE_CHECK_INTERVAL_MS } from './sw-update-scheduler.js'

// Minimal fake Document surface: startSwUpdateScheduler only needs
// visibilitychange add/remove + a mutable visibilityState.
function createFakeDoc(): {
  doc: Pick<Document, 'addEventListener' | 'removeEventListener'> & {
    visibilityState: DocumentVisibilityState
  }
  fireVisibilityChange: (state: DocumentVisibilityState) => void
  listenerCount: () => number
} {
  const listeners = new Set<() => void>()
  const doc = {
    visibilityState: 'visible' as DocumentVisibilityState,
    addEventListener: vi.fn((event: string, handler: () => void) => {
      if (event === 'visibilitychange') listeners.add(handler)
    }),
    removeEventListener: vi.fn((event: string, handler: () => void) => {
      if (event === 'visibilitychange') listeners.delete(handler)
    }),
  }
  return {
    doc,
    fireVisibilityChange: (state: DocumentVisibilityState) => {
      doc.visibilityState = state
      for (const listener of listeners) listener()
    },
    listenerCount: () => listeners.size,
  }
}

describe('startSwUpdateScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('calls update() once per interval tick', () => {
    const { doc } = createFakeDoc()
    const update = vi.fn().mockResolvedValue(undefined)
    const stop = startSwUpdateScheduler({ update, doc })

    vi.advanceTimersByTime(SW_UPDATE_CHECK_INTERVAL_MS)
    expect(update).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(SW_UPDATE_CHECK_INTERVAL_MS)
    expect(update).toHaveBeenCalledTimes(2)

    stop()
  })

  it('calls update() once when the document becomes visible', () => {
    const { doc, fireVisibilityChange } = createFakeDoc()
    const update = vi.fn().mockResolvedValue(undefined)
    const stop = startSwUpdateScheduler({ update, doc })

    fireVisibilityChange('visible')
    expect(update).toHaveBeenCalledTimes(1)

    stop()
  })

  it('does not call update() when visibilitychange fires while hidden', () => {
    const { doc, fireVisibilityChange } = createFakeDoc()
    const update = vi.fn().mockResolvedValue(undefined)
    const stop = startSwUpdateScheduler({ update, doc })

    fireVisibilityChange('hidden')
    expect(update).not.toHaveBeenCalled()

    stop()
  })

  it('swallows a rejecting update() without an unhandled rejection, and keeps scheduling', async () => {
    const { doc } = createFakeDoc()
    const update = vi.fn().mockRejectedValue(new Error('offline'))
    const unhandledRejections: unknown[] = []
    const onUnhandledRejection = (event: PromiseRejectionEvent): void => {
      unhandledRejections.push(event.reason)
    }
    window.addEventListener('unhandledrejection', onUnhandledRejection)

    try {
      const stop = startSwUpdateScheduler({ update, doc })

      vi.advanceTimersByTime(SW_UPDATE_CHECK_INTERVAL_MS)
      // let the rejected promise's .catch() microtask settle under fake timers
      await vi.waitFor(() => expect(update).toHaveBeenCalledTimes(1))

      vi.advanceTimersByTime(SW_UPDATE_CHECK_INTERVAL_MS)
      await vi.waitFor(() => expect(update).toHaveBeenCalledTimes(2))

      expect(unhandledRejections).toEqual([])
      stop()
    } finally {
      window.removeEventListener('unhandledrejection', onUnhandledRejection)
    }
  })

  it('dispose() clears the interval and removes the visibilitychange listener', () => {
    const { doc, fireVisibilityChange, listenerCount } = createFakeDoc()
    const update = vi.fn().mockResolvedValue(undefined)
    const stop = startSwUpdateScheduler({ update, doc })

    expect(listenerCount()).toBe(1)
    stop()
    expect(listenerCount()).toBe(0)

    vi.advanceTimersByTime(SW_UPDATE_CHECK_INTERVAL_MS * 2)
    fireVisibilityChange('visible')
    expect(update).not.toHaveBeenCalled()
  })

  it('accepts a custom intervalMs', () => {
    const { doc } = createFakeDoc()
    const update = vi.fn().mockResolvedValue(undefined)
    const stop = startSwUpdateScheduler({ update, doc, intervalMs: 1000 })

    vi.advanceTimersByTime(1000)
    expect(update).toHaveBeenCalledTimes(1)

    stop()
  })
})
