/**
 * ADR-0050: a daemon reached through the whiteboard extension needs no
 * consent step or token — the extension, its native host and the owner-only
 * socket are the whole trust chain — so connecting is asking whether the
 * daemon answers.
 */
import { describe, expect, it, vi } from 'vitest'
import { jsonResponse } from '../test-utils/json-response.js'
import { BRIDGE_DAEMON_BASE_URL } from './bridge-address.js'
import { createBridgeFetch } from './extension-bridge-fetch.js'
import type { BridgePort } from './extension-bridge-port.js'
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

  // The native host answers `daemon-record-refused` with what the daemon
  // record said, and the bridge rejects with that text after the reason. A refusal
  // naming a live daemon of another version must reach the person, or they
  // are sent to start a daemon the CLI then refuses to start.
  it("carries the host's refusal when the daemon record refuses", async () => {
    const refusal =
      'the daemon record /data/daemon.json cannot be interpreted by this version, but names pid 4242, which is running'
    const fetchFn = vi.fn<typeof fetch>(async () =>
      Promise.reject(new TypeError(`daemon-record-refused: ${refusal}`)),
    )
    expect(await connectThroughExtension(fetchFn)).toEqual({ status: 'none', refusal })
  })

  // The refusal is read from the text the bridge builds, so this goes through
  // the real bridge: a change to how it words a host error must fail here.
  it('reads the refusal from what the real bridge rejects with', async () => {
    const refusal = 'the daemon record /data/daemon.json is not owned by this user'
    const listeners: Array<(message: unknown) => void> = []
    const port: BridgePort = {
      onMessage: { addListener: (l) => void listeners.push(l) },
      onDisconnect: { addListener: () => {} },
      postMessage: (m) => {
        if (m.type !== 'request') return
        const frame = {
          type: 'error',
          id: m.id,
          reason: 'daemon-record-refused',
          message: refusal,
        }
        queueMicrotask(() => {
          for (const l of listeners) l(frame)
        })
      },
      disconnect: () => {},
    }
    expect(await connectThroughExtension(createBridgeFetch(() => port))).toEqual({
      status: 'none',
      refusal,
    })
  })

  it.each([
    ['no daemon is running', new TypeError('daemon-unreachable: no daemon is running')],
    ['another kind of bridge error', new TypeError('stream-failed: socket closed at /tmp/x')],
    ['a plain network error', new TypeError('the whiteboard extension is not available')],
    ['an empty refusal', new TypeError('daemon-record-refused: ')],
    // A daemon that died uncleanly leaves its record, and its socket answers
    // an errno: that is "start one", not something the record said.
    ['a socket nobody serves', new TypeError('daemon-unreachable: connect ENOENT /x.sock')],
    ['a socket that refuses', new TypeError('daemon-unreachable: connect ECONNREFUSED /x.sock')],
  ])('carries no refusal for %s', async (_why, err) => {
    const fetchFn = vi.fn<typeof fetch>(async () => Promise.reject(err))
    expect(await connectThroughExtension(fetchFn)).toEqual({ status: 'none' })
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
