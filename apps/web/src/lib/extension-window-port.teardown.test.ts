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

it('an abandoned hello stops listening and answers no at once', async () => {
  vi.useFakeTimers()
  const removed = vi.spyOn(window, 'removeEventListener')
  const asked = new AbortController()
  const answer = windowHello(60_000, asked.signal)
  asked.abort()
  // No timer advance: the answer must not wait for the hello's timeout.
  await expect(answer).resolves.toBe(false)
  expect(removed).toHaveBeenCalledWith('message', expect.any(Function))
})
