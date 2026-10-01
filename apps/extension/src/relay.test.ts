/**
 * The service worker's whole job: pair each page connection with one native
 * host process and pass messages both ways, refusing a page the manifest
 * does not admit.
 */
import {
  extensionHelloReplySchema,
  extensionToPageSchema,
} from '@kamiazya/whiteboard-daemon-client/extension-bridge'
import { NATIVE_HOST_NAME } from '@kamiazya/whiteboard-daemon-client/extension-names'
import { describe, expect, it } from 'vitest'
import { type ExtensionApi, installRelay, type Port } from './relay.js'

class FakePort implements Port {
  readonly sent: unknown[] = []
  disconnected = false
  error?: { message?: string }
  private readonly messageListeners: Array<(message: unknown) => void> = []
  private readonly disconnectListeners: Array<() => void> = []
  constructor(readonly sender?: { origin?: string; url?: string }) {}
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
  /** The other end sends. */
  receive(message: unknown) {
    for (const l of this.messageListeners) l(message)
  }
  /** The other end goes away. */
  drop() {
    for (const l of this.disconnectListeners) l()
  }
}

function fakeApi(lastError?: string) {
  const natives: Array<{ name: string; port: FakePort }> = []
  let onConnectExternal: ((port: Port) => void) | undefined
  let onConnect: ((port: Port) => void) | undefined
  let onMessageExternal:
    | ((message: unknown, sender: { origin?: string }, reply: (r: unknown) => void) => void)
    | undefined
  const api: ExtensionApi = {
    runtime: {
      connectNative: (name) => {
        const port = new FakePort()
        natives.push({ name, port })
        return port
      },
      get lastError() {
        return lastError === undefined ? undefined : { message: lastError }
      },
      getManifest: () => ({ version: '9.9.9' }),
      onConnectExternal: { addListener: (l) => (onConnectExternal = l) },
      onConnect: { addListener: (l) => (onConnect = l) },
      onMessageExternal: { addListener: (l) => (onMessageExternal = l) },
    },
  }
  return {
    api,
    natives,
    connect: (port: FakePort) => onConnectExternal?.(port),
    connectFromContentScript: (port: FakePort) => onConnect?.(port),
    message: (message: unknown, origin: string) =>
      new Promise<unknown>((resolve) => onMessageExternal?.(message, { origin }, resolve)),
  }
}

const MATCHES = ['https://kamiazya-whiteboard.pages.dev/*']
const APP = 'https://kamiazya-whiteboard.pages.dev'

describe('installRelay', () => {
  it('relays a page connection to its own native host, both ways', () => {
    const fake = fakeApi()
    installRelay(fake.api, MATCHES)
    const page = new FakePort({ origin: APP })
    fake.connect(page)

    expect(fake.natives.map((n) => n.name)).toEqual([NATIVE_HOST_NAME])
    const native = fake.natives[0]?.port
    if (native === undefined) throw new Error('no native host was started')
    page.receive({ type: 'request', id: 'a' })
    native.receive({ type: 'end', id: 'a' })
    expect(native.sent).toEqual([{ type: 'request', id: 'a' }])
    expect(page.sent).toEqual([{ type: 'end', id: 'a' }])

    page.drop()
    expect(native.disconnected).toBe(true)
  })

  it('refuses a page the manifest does not admit, without starting the host', () => {
    const fake = fakeApi()
    installRelay(fake.api, MATCHES)
    const page = new FakePort({ origin: 'https://evil.example' })
    fake.connect(page)

    expect(page.disconnected).toBe(true)
    expect(fake.natives).toEqual([])
  })

  // The host missing, crashed or refused all arrive as a disconnect; the page
  // learns why instead of waiting on a port that will never answer.
  it('tells the page when its host goes away, then closes', () => {
    const fake = fakeApi('Specified native messaging host not found.')
    installRelay(fake.api, MATCHES)
    const page = new FakePort({ origin: APP })
    fake.connect(page)

    fake.natives[0]?.port.drop()
    expect(page.sent).toEqual([
      { type: 'disconnected', message: 'Specified native messaging host not found.' },
    ])
    // The page reads it through this schema; a field it does not know is
    // stripped by the parse and fails the equality.
    expect(page.sent.map((m) => extensionToPageSchema.parse(m))).toEqual(page.sent)
    expect(page.disconnected).toBe(true)
  })

  it('answers an admitted page that asks whether it is installed', async () => {
    const fake = fakeApi()
    installRelay(fake.api, MATCHES)
    const reply = await fake.message({ type: 'hello' }, APP)
    expect(reply).toEqual({ type: 'hello', version: '9.9.9' })
    expect(extensionHelloReplySchema.parse(reply)).toEqual(reply)
  })

  // Firefox: the page reaches the relay through the content script, whose
  // port names the page it runs in by URL.
  it('relays a content script on an admitted page, and refuses one elsewhere', () => {
    const fake = fakeApi()
    installRelay(fake.api, MATCHES)
    const admitted = new FakePort({ url: `${APP}/w/default` })
    fake.connectFromContentScript(admitted)
    const elsewhere = new FakePort({ url: 'https://evil.example/' })
    fake.connectFromContentScript(elsewhere)

    expect(fake.natives.map((n) => n.name)).toEqual([NATIVE_HOST_NAME])
    admitted.receive({ type: 'request', id: 'a' })
    expect(fake.natives[0]?.port.sent).toEqual([{ type: 'request', id: 'a' }])
    expect(elsewhere.disconnected).toBe(true)
  })

  it('tells the page why its host went away where Firefox puts it, on the port', () => {
    const fake = fakeApi()
    installRelay(fake.api, MATCHES)
    const page = new FakePort({ origin: APP })
    fake.connect(page)
    const native = fake.natives[0]?.port
    if (native === undefined) throw new Error('no native host was started')
    native.error = { message: 'No such native application io.github.kamiazya.whiteboard' }

    native.drop()
    expect(page.sent).toEqual([
      { type: 'disconnected', message: 'No such native application io.github.kamiazya.whiteboard' },
    ])
  })
})
