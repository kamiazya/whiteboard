/**
 * ADR-0050: a daemon reached through the whiteboard extension needs no
 * consent step or token — the extension, its native host and the owner-only
 * socket are the whole trust chain — so connecting is asking whether the
 * daemon answers.
 */
import { describe, expect, it, vi } from 'vitest'
import { jsonResponse } from '../test-utils/json-response.js'
import { BRIDGE_DAEMON_BASE_URL } from './bridge-address.js'
import { CONNECT_TIMEOUT_MS, connectThroughExtension } from './extension-connection.js'

describe('connectThroughExtension', () => {
  it('pairs with the bridged daemon when it answers the ping, holding no credential', async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => jsonResponse({ ok: true }))
    expect(await connectThroughExtension(fetchFn)).toEqual({
      status: 'connected',
      daemonBaseUrl: BRIDGE_DAEMON_BASE_URL,
    })
    expect(String(fetchFn.mock.calls[0]?.[0])).toBe(`${BRIDGE_DAEMON_BASE_URL}/api/runtime/ping`)
  })

  it.each([
    ['the extension or its host is missing', async () => Promise.reject(new TypeError('gone'))],
    ['the daemon answers badly', async () => new Response('', { status: 502 })],
  ])('connects nothing when %s', async (_why, answer) => {
    expect(await connectThroughExtension(vi.fn<typeof fetch>(answer))).toEqual({ status: 'none' })
  })

  // The app shows "Connecting…" until this answers, so a host that never
  // answers must not hold it there.
  it('gives up on a daemon that never answers', async () => {
    vi.useFakeTimers()
    try {
      // Answers nothing, and ends only when aborted — as fetch does.
      const silent = vi.fn<typeof fetch>(
        (_input, init) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(init.signal?.reason))
          }),
      )
      const pending = connectThroughExtension(silent)
      await vi.advanceTimersByTimeAsync(CONNECT_TIMEOUT_MS)
      expect(await pending).toEqual({ status: 'none' })
    } finally {
      vi.useRealTimers()
    }
  })
})
