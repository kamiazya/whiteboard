// @vitest-environment jsdom
/**
 * The hello waits on a timer, and the page that asked may be gone before it
 * fires — a test's environment torn down, or a page unloading. Answering then
 * must not reach for a `window` that is no longer there: vitest reports that
 * throw as an unhandled error and fails the run whose tests all passed.
 */
import { afterEach, expect, it, vi } from 'vitest'
import { windowHello } from './extension-window-port.js'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

it('answers no after the window it listened on has gone', async () => {
  vi.useFakeTimers()
  const answer = windowHello(50)
  vi.stubGlobal('window', undefined)
  vi.advanceTimersByTime(50)
  await expect(answer).resolves.toBe(false)
})
