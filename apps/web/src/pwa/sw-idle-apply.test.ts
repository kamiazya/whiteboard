// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SW_IDLE_SETTLE_MS, startSwIdleAutoApply } from './sw-idle-apply.js'

function fakeDoc(initial: DocumentVisibilityState = 'visible') {
  let visibilityState = initial
  const listeners = new Set<() => void>()
  return {
    get visibilityState() {
      return visibilityState
    },
    addEventListener: (_type: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener),
    setVisibility(next: DocumentVisibilityState) {
      visibilityState = next
      for (const listener of listeners) listener()
    },
    listenerCount: () => listeners.size,
  }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('startSwIdleAutoApply', () => {
  it('applies once the tab has stayed hidden long enough', async () => {
    const apply = vi.fn()
    const doc = fakeDoc()
    startSwIdleAutoApply({ apply, doc: doc as unknown as Document })

    doc.setVisibility('hidden')
    expect(apply).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(SW_IDLE_SETTLE_MS)
    expect(apply).toHaveBeenCalledTimes(1)
  })

  // The other cases read the constant, so they follow any value it is given.
  // Five seconds is the decision — past a quick tab switch and past the
  // editor's debounced write window — so it is spelled as a literal here once.
  it('settles for five seconds of hidden time, no less', async () => {
    const apply = vi.fn()
    const doc = fakeDoc()
    startSwIdleAutoApply({ apply, doc: doc as unknown as Document })

    doc.setVisibility('hidden')
    await vi.advanceTimersByTimeAsync(4_999)
    expect(apply).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(apply).toHaveBeenCalledTimes(1)
  })

  // Applying reloads the page. Doing that under someone who is looking at it —
  // let alone mid-drag — is exactly what the prompt strategy exists to avoid.
  it('never applies while the tab is visible', async () => {
    const apply = vi.fn()
    const doc = fakeDoc()
    startSwIdleAutoApply({ apply, doc: doc as unknown as Document })

    await vi.advanceTimersByTimeAsync(SW_IDLE_SETTLE_MS * 5)
    expect(apply).not.toHaveBeenCalled()
  })

  // Coming back before the settle period means the user was switching tabs,
  // not leaving — the reload would land just as they return to their canvas.
  it('abandons the apply if the tab comes back first', async () => {
    const apply = vi.fn()
    const doc = fakeDoc()
    startSwIdleAutoApply({ apply, doc: doc as unknown as Document })

    doc.setVisibility('hidden')
    await vi.advanceTimersByTimeAsync(SW_IDLE_SETTLE_MS / 2)
    doc.setVisibility('visible')
    await vi.advanceTimersByTimeAsync(SW_IDLE_SETTLE_MS * 3)

    expect(apply).not.toHaveBeenCalled()
  })

  // The settle period is what covers a debounced write that has not flushed
  // yet, so a caller that still has work in flight can hold the swap off.
  it('holds off while the caller reports work in flight', async () => {
    const apply = vi.fn()
    const doc = fakeDoc()
    let busy = true
    startSwIdleAutoApply({ apply, doc: doc as unknown as Document, isIdle: () => !busy })

    doc.setVisibility('hidden')
    await vi.advanceTimersByTimeAsync(SW_IDLE_SETTLE_MS * 3)
    expect(apply).not.toHaveBeenCalled()

    busy = false
    doc.setVisibility('visible')
    doc.setVisibility('hidden')
    await vi.advanceTimersByTimeAsync(SW_IDLE_SETTLE_MS)
    expect(apply).toHaveBeenCalledTimes(1)
  })

  it('stops listening when the returned stop is called', async () => {
    const apply = vi.fn()
    const doc = fakeDoc()
    const stop = startSwIdleAutoApply({ apply, doc: doc as unknown as Document })

    stop()
    expect(doc.listenerCount()).toBe(0)

    doc.setVisibility('hidden')
    await vi.advanceTimersByTimeAsync(SW_IDLE_SETTLE_MS * 3)
    expect(apply).not.toHaveBeenCalled()
  })
})
