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

vi.mock('./extension-window-port.js', async () => ({
  windowHello: vi.fn(async () => ({
    type: 'hello',
    version: '1.0.0',
    protocol: (await import('@kamiazya/whiteboard-daemon-client/extension-names'))
      .BRIDGE_PROTOCOL_VERSION,
  })),
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
    expect(windowHello).toHaveBeenCalledWith(250, undefined)
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

  it('refuses to carry a request through a content script that speaks another protocol', async () => {
    vi.mocked(windowHello).mockResolvedValueOnce({ type: 'hello', version: '0.0.1' })
    await expect(
      extensionBridgeFetch(`${BRIDGE_DAEMON_BASE_URL}/api/runtime/ping`),
    ).rejects.toThrow(/version 0\.0\.1.*predates the bridge protocol check.*update the extension/)
    expect(connectThroughWindow).not.toHaveBeenCalled()
  })
})
