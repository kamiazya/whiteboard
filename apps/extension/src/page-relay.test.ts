/**
 * Firefox: the content script's whole job — carry messages between the page's
 * window and the extension, for ports the page names, and answer whether it
 * is there. It reads nothing it relays; the host validates.
 */
import {
  windowFromExtensionSchema,
  windowFromPageSchema,
} from '@kamiazya/whiteboard-daemon-client/extension-bridge'
import { WINDOW_BRIDGE_CHANNEL } from '@kamiazya/whiteboard-daemon-client/extension-names'
import { describe, expect, it } from 'vitest'
import { installPageRelay, type PageWindow } from './page-relay.js'
import type { Port } from './relay.js'

const ORIGIN = 'https://kamiazya-whiteboard.pages.dev'

class FakePort implements Port {
  readonly sent: unknown[] = []
  disconnected = false
  readonly messageListeners: Array<(message: unknown) => void> = []
  readonly disconnectListeners: Array<() => void> = []
  readonly onMessage = {
    addListener: (l: (message: unknown) => void) => this.messageListeners.push(l),
  }
  readonly onDisconnect = { addListener: (l: () => void) => this.disconnectListeners.push(l) }
  postMessage(message: unknown) {
    this.sent.push(message)
  }
  disconnect() {
    this.disconnected = true
  }
}

function fakePage() {
  const posted: unknown[] = []
  let listener: ((event: { source: unknown; origin: string; data: unknown }) => void) | undefined
  const win: PageWindow = {
    location: { origin: ORIGIN },
    addEventListener: (_type, l) => (listener = l),
    postMessage: (message, targetOrigin) => {
      expect(targetOrigin).toBe(ORIGIN)
      // What the page reads is parsed by this schema, so a field it does not
      // know is stripped by the parse and fails the equality.
      expect(windowFromExtensionSchema.parse(message)).toEqual(message)
      posted.push(message)
    },
  }
  const ports: FakePort[] = []
  installPageRelay(win, {
    runtime: {
      connect: () => {
        const port = new FakePort()
        ports.push(port)
        return port
      },
      getManifest: () => ({ version: '9.9.9' }),
    },
  })
  const fromPage = (data: object, source: unknown = win, origin = ORIGIN) =>
    listener?.({ source, origin, data: { channel: WINDOW_BRIDGE_CHANNEL, from: 'page', ...data } })
  // A message the page's own sender would produce: it must be one the schema
  // that types that sender accepts, or the test is driving the relay with
  // something the page can never post.
  const fromPageTyped = (data: object) => {
    const message = { channel: WINDOW_BRIDGE_CHANNEL, from: 'page', ...data }
    expect(windowFromPageSchema.parse(message)).toEqual(message)
    return listener?.({ source: win, origin: ORIGIN, data: message })
  }
  return { posted, ports, fromPage, fromPageTyped }
}

const toPage = (data: object) => ({ channel: WINDOW_BRIDGE_CHANNEL, from: 'extension', ...data })

describe('installPageRelay', () => {
  it('answers a page that asks whether it is there', () => {
    const page = fakePage()
    page.fromPageTyped({ kind: 'hello' })
    expect(page.posted).toEqual([toPage({ kind: 'hello', version: '9.9.9' })])
  })

  it('opens a port for the page, and carries messages both ways under its name', () => {
    const page = fakePage()
    page.fromPageTyped({ kind: 'connect', port: 'p1' })
    page.fromPageTyped({ kind: 'message', port: 'p1', message: { type: 'abort', id: 'a' } })
    const port = page.ports[0]
    if (port === undefined) throw new Error('no port was opened')
    for (const l of port.messageListeners) l({ type: 'end', id: 'a' })

    expect(port.sent).toEqual([{ type: 'abort', id: 'a' }])
    expect(page.posted).toEqual([
      toPage({ kind: 'connected', port: 'p1' }),
      toPage({ kind: 'message', port: 'p1', message: { type: 'end', id: 'a' } }),
    ])
  })

  // The host answers a request it refuses with a `bad-request` of its own, so
  // the relay must not drop what it cannot judge.
  it('carries a request the host will refuse, rather than dropping it', () => {
    const page = fakePage()
    page.fromPageTyped({ kind: 'connect', port: 'p1' })
    const refused = { type: 'request', id: 'r', method: 'GET', path: '/api/../x', headers: {} }
    page.fromPage({ kind: 'message', port: 'p1', message: refused })
    expect(page.ports[0]?.sent).toEqual([refused])
  })

  it('ignores a port message with no port name', () => {
    const page = fakePage()
    page.fromPage({ kind: 'connect', port: 'p1' })
    page.fromPage({ kind: 'message', message: { type: 'abort', id: 'a' } })
    page.fromPage({ kind: 'connect', port: 7 })
    expect(page.ports).toHaveLength(1)
    expect(page.ports[0]?.sent).toEqual([])
  })

  it('closes a port either side ends', () => {
    const page = fakePage()
    page.fromPageTyped({ kind: 'connect', port: 'p1' })
    page.fromPageTyped({ kind: 'connect', port: 'p2' })
    page.fromPageTyped({ kind: 'disconnect', port: 'p1' })
    for (const l of page.ports[1]?.disconnectListeners ?? []) l()

    expect(page.ports.map((p) => p.disconnected)).toEqual([true, false])
    expect(page.posted.at(-1)).toEqual(toPage({ kind: 'disconnect', port: 'p2' }))
  })

  // Only the page itself speaks on this channel: not a frame of another
  // origin, and not the relay's own replies, which arrive on the same window.
  it('ignores what the page did not post', () => {
    const page = fakePage()
    page.fromPage({ kind: 'hello' }, {}, ORIGIN)
    page.fromPage({ kind: 'hello' }, undefined, 'https://evil.example')
    page.fromPage({ kind: 'connect', port: 'p1', from: 'extension' })
    page.fromPage({ kind: 'connect', port: 'p1', channel: 'another' })
    expect(page.posted).toEqual([])
    expect(page.ports).toEqual([])
  })
})
