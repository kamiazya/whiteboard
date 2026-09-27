/**
 * Where the page has no `chrome.runtime` for the extension — Firefox, which
 * lets no page message an extension — the bridge goes through the content
 * script on this window instead.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BRIDGE_DAEMON_BASE_URL } from './bridge-address.js'
import { extensionBridgeFetch, extensionPresent } from './extension-bridge-fetch.js'
import { connectThroughWindow, windowHello } from './extension-window-port.js'

// The bridge is one port per page, held across calls; the port each test
// opens is closed after it, so the next test (or repeat) opens its own.
const dropPort = vi.hoisted(() => ({ current: () => {} }))

vi.mock('./extension-window-port.js', () => ({
  windowHello: vi.fn(async () => true),
  connectThroughWindow: vi.fn(() => ({
    onMessage: { addListener: () => {} },
    onDisconnect: {
      addListener: (listener: () => void) => {
        dropPort.current = listener
      },
    },
    postMessage: () => {},
    disconnect: () => {},
  })),
}))

afterEach(() => {
  dropPort.current()
  vi.clearAllMocks()
})

describe('the bridge without chrome.runtime', () => {
  it('asks the content script whether the extension is there', async () => {
    expect(await extensionPresent(250)).toBe(true)
    expect(windowHello).toHaveBeenCalledWith(250)
  })

  it('opens its port through the content script', async () => {
    const giveUp = new AbortController()
    const pending = extensionBridgeFetch(`${BRIDGE_DAEMON_BASE_URL}/api/runtime/ping`, {
      signal: giveUp.signal,
    })
    giveUp.abort()
    await expect(pending).rejects.toThrow()
    expect(connectThroughWindow).toHaveBeenCalledTimes(1)
  })
})
