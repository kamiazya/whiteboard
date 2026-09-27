/**
 * ADR-0050: a daemon reached through the whiteboard extension needs no
 * pairing — the extension, its native host and the owner-only socket are the
 * whole trust chain — so connecting is asking whether the daemon answers.
 */
import { describe, expect, it, vi } from 'vitest'
import { BRIDGE_DAEMON_BASE_URL } from './extension-bridge-fetch.js'
import { connectThroughExtension } from './extension-connection.js'

describe('connectThroughExtension', () => {
  it('pairs with the bridged daemon when it answers the ping, holding no token', async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => new Response('{"ok":true}', { status: 200 }))
    expect(await connectThroughExtension(fetchFn)).toEqual({
      status: 'paired',
      daemonBaseUrl: BRIDGE_DAEMON_BASE_URL,
      token: '',
    })
    expect(String(fetchFn.mock.calls[0]?.[0])).toBe(`${BRIDGE_DAEMON_BASE_URL}/api/runtime/ping`)
  })

  it.each([
    ['the extension or its host is missing', async () => Promise.reject(new TypeError('gone'))],
    ['the daemon answers badly', async () => new Response('', { status: 502 })],
  ])('connects nothing when %s', async (_why, answer) => {
    expect(await connectThroughExtension(vi.fn<typeof fetch>(answer))).toEqual({ status: 'none' })
  })
})
