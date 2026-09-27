/**
 * The service worker's whole job: pair each page connection with one native
 * host process and pass messages both ways, refusing a page the manifest
 * does not admit.
 */
import { NATIVE_HOST_NAME } from '@kamiazya/whiteboard-daemon-client/extension-names'
import { describe, expect, it } from 'vitest'
import { type ExtensionApi, installRelay, type Port } from './relay.js'

class FakePort implements Port {
  readonly sent: unknown[] = []
  disconnected = false
  private readonly messageListeners: Array<(message: unknown) => void> = []
  private readonly disconnectListeners: Array<() => void> = []
  constructor(readonly sender?: { origin?: string }) {}
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
      onMessageExternal: { addListener: (l) => (onMessageExternal = l) },
    },
  }
  return {
    api,
    natives,
    connect: (port: FakePort) => onConnectExternal?.(port),
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
    expect(page.disconnected).toBe(true)
  })

  it('answers an admitted page that asks whether it is installed', async () => {
    const fake = fakeApi()
    installRelay(fake.api, MATCHES)
    expect(await fake.message({ type: 'hello' }, APP)).toEqual({ type: 'hello', version: '9.9.9' })
  })
})
