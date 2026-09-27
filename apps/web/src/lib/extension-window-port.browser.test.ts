/**
 * Firefox: the page reaches the whiteboard extension through its content
 * script, over this page's own window. Here the test plays the content
 * script, in a real browser, so `postMessage`'s origin and ordering are the
 * browser's own.
 */
import { WINDOW_BRIDGE_CHANNEL } from '@kamiazya/whiteboard-daemon-client/extension-names'
import { afterEach, describe, expect, it } from 'vitest'
import { connectThroughWindow, windowHello } from './extension-window-port.js'

type FromPage = { channel: string; from: string; kind: string; port?: string; message?: unknown }

let stop: (() => void) | undefined
afterEach(() => stop?.())

/** A content script that answers as the extension's does. */
function contentScript(answer: (data: FromPage, reply: (m: object) => void) => void) {
  const heard: FromPage[] = []
  const listener = (event: MessageEvent) => {
    const data = event.data as FromPage
    if (data?.channel !== WINDOW_BRIDGE_CHANNEL || data.from !== 'page') return
    heard.push(data)
    answer(data, (m) =>
      window.postMessage(
        { channel: WINDOW_BRIDGE_CHANNEL, from: 'extension', ...m },
        location.origin,
      ),
    )
  }
  window.addEventListener('message', listener)
  stop = () => window.removeEventListener('message', listener)
  return heard
}

describe('windowHello', () => {
  it('answers whether a content script is there', async () => {
    contentScript((data, reply) => {
      if (data.kind === 'hello') reply({ kind: 'hello', version: '1.2.3' })
    })
    expect(await windowHello(1_000)).toBe(true)
  })

  it('answers no when nothing replies', async () => {
    expect(await windowHello(50)).toBe(false)
  })
})

describe('connectThroughWindow', () => {
  it('carries messages both ways under the port it names', async () => {
    const heard = contentScript((data, reply) => {
      if (data.kind === 'connect') reply({ kind: 'connected', port: data.port })
      if (data.kind === 'message') {
        reply({ kind: 'message', port: 'another-port', message: { type: 'end', id: 'x' } })
        reply({ kind: 'message', port: data.port, message: { type: 'end', id: 'a' } })
      }
    })
    const port = connectThroughWindow()
    const received: unknown[] = []
    port.onMessage.addListener((m) => received.push(m))
    port.postMessage({ type: 'abort', id: 'a' })

    await expect.poll(() => received).toEqual([{ type: 'end', id: 'a' }])
    expect(heard.map((m) => m.kind)).toEqual(['connect', 'message'])
    expect(heard[1]?.message).toEqual({ type: 'abort', id: 'a' })
  })

  it('closes when the content script says the extension went away', async () => {
    contentScript((data, reply) => {
      if (data.kind === 'connect') {
        reply({ kind: 'connected', port: data.port })
        reply({ kind: 'disconnect', port: data.port })
      }
    })
    const port = connectThroughWindow()
    let closed = false
    port.onDisconnect.addListener(() => {
      closed = true
    })
    await expect.poll(() => closed).toBe(true)
  })

  // With no extension on the page nothing ever answers, and a port that
  // waited forever would hold every request with it.
  it('closes when no content script acknowledges it', async () => {
    const port = connectThroughWindow(50)
    let closed = false
    port.onDisconnect.addListener(() => {
      closed = true
    })
    await expect.poll(() => closed).toBe(true)
  })
})
