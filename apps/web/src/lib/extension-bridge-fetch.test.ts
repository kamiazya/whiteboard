/**
 * ADR-0050: the hosted page reaches the daemon through the whiteboard
 * extension. `createBridgeFetch` is that transport shaped as `fetch`, so the
 * app's calls — plain requests and the SSE stream alike — keep their shape
 * and only the function they are handed changes.
 */
import { bridgeSkew, pageToHostSchema } from '@kamiazya/whiteboard-daemon-client/extension-bridge'
import { BRIDGE_PROTOCOL_VERSION } from '@kamiazya/whiteboard-daemon-client/extension-names'
import { bytesToBase64 } from '@kamiazya/whiteboard-model'
import { describe, expect, it, vi } from 'vitest'
import { BRIDGE_DAEMON_BASE_URL, isBridgeDaemon } from './bridge-address.js'
import { createBridgeFetch } from './extension-bridge-fetch.js'
import type { BridgePort } from './extension-bridge-port.js'

/** The extension's end of the port, answering as the native host would. */
class FakeExtension {
  readonly ports: FakePort[] = []
  /** What the host answers a hello with; `null` is a host that predates the check. */
  hostHello: { version: string; protocol?: number } | null = {
    version: '1.0.0',
    protocol: BRIDGE_PROTOCOL_VERSION,
  }
  connect = (): BridgePort => {
    const port = new FakePort(this)
    this.ports.push(port)
    return port
  }
  get port(): FakePort {
    const port = this.ports.at(-1)
    if (port === undefined) throw new Error('nothing connected')
    return port
  }
}

class FakePort implements BridgePort {
  constructor(private readonly extension: FakeExtension) {}
  readonly sent: Array<Record<string, unknown>> = []
  /** Every hello the page asked the host, kept apart from the requests in `sent`. */
  readonly hellos: Array<Record<string, unknown>> = []
  private message: Array<(m: unknown) => void> = []
  private disconnect_: Array<() => void> = []
  readonly onMessage = { addListener: (l: (m: unknown) => void) => void this.message.push(l) }
  readonly onDisconnect = { addListener: (l: () => void) => void this.disconnect_.push(l) }
  // The host reads every message through this schema, so what the page posts
  // must survive it unchanged: a stray or misspelled field is stripped by the
  // parse and so fails the equality.
  postMessage(m: unknown) {
    const parsed = pageToHostSchema.parse(m)
    expect(parsed).toEqual(m)
    if (parsed.type === 'hello') {
      this.hellos.push(parsed)
      if (this.extension.hostHello !== null) {
        this.reply({ type: 'hello', ...this.extension.hostHello })
      }
      return
    }
    this.sent.push(parsed)
  }
  disconnect() {}
  reply(m: unknown) {
    for (const l of this.message) l(m)
  }
  drop() {
    for (const l of this.disconnect_) l()
  }
  /** The id of the last request the page sent. */
  get lastId(): string {
    return String(this.sent.filter((m) => m.type === 'request').at(-1)?.id)
  }
}

const bytes = (text: string) => bytesToBase64(new TextEncoder().encode(text))
const at = (path: string) => `${BRIDGE_DAEMON_BASE_URL}${path}`

describe('createBridgeFetch', () => {
  it('sends a request as the bridge message and answers it as a Response', async () => {
    const ext = new FakeExtension()
    const bridgeFetch = createBridgeFetch(ext.connect)

    const pending = bridgeFetch(at('/api/workspaces?limit=1'), {
      headers: { accept: 'application/json' },
    })
    await sentFrom(ext)
    expect(ext.port.sent).toEqual([
      expect.objectContaining({
        type: 'request',
        method: 'GET',
        path: '/api/workspaces?limit=1',
        headers: { accept: 'application/json' },
      }),
    ])
    expect(ext.port.sent[0]).not.toHaveProperty('body')
    const id = ext.port.lastId
    ext.port.reply({
      type: 'head',
      id,
      status: 201,
      headers: { 'content-type': 'application/json' },
    })
    ext.port.reply({ type: 'chunk', id, data: bytes('{"ok":') })
    ext.port.reply({ type: 'chunk', id, data: bytes('true}') })
    ext.port.reply({ type: 'end', id })

    const res = await pending
    expect(res.status).toBe(201)
    expect(res.headers.get('content-type')).toBe('application/json')
    expect(await res.json()).toEqual({ ok: true })
  })

  it('carries a request body as base64', async () => {
    const ext = new FakeExtension()
    void createBridgeFetch(ext.connect)(at('/api/x'), {
      method: 'POST',
      body: new Uint8Array([0, 1, 255]),
    })
    await sentFrom(ext)
    expect(ext.port.sent[0]).toMatchObject({
      method: 'POST',
      body: bytesToBase64(new Uint8Array([0, 1, 255])),
    })
  })

  it('refuses a method the bridge does not carry without posting anything', async () => {
    const ext = new FakeExtension()
    const bridgeFetch = createBridgeFetch(ext.connect)
    await expect(bridgeFetch(at('/api/workspaces'), { method: 'OPTIONS' })).rejects.toThrow(
      /does not carry OPTIONS/,
    )
    expect(ext.ports).toEqual([])
  })

  // The SSE stream is read as it arrives, never after an end it may not have.
  it('lets the body be read before the response has ended', async () => {
    const ext = new FakeExtension()
    const pending = createBridgeFetch(ext.connect)(at('/api/sync/stream'))
    await sentFrom(ext)
    const id = ext.port.lastId
    ext.port.reply({
      type: 'head',
      id,
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    })
    ext.port.reply({ type: 'chunk', id, data: bytes('event: ready\n\n') })

    const reader = (await pending).body?.getReader()
    const first = await reader?.read()
    expect(new TextDecoder().decode(first?.value)).toBe('event: ready\n\n')

    await reader?.cancel()
    expect(ext.port.sent.at(-1)).toEqual({ type: 'abort', id })
  })

  it('aborts at the host when the signal fires, and rejects as fetch does', async () => {
    const ext = new FakeExtension()
    const controller = new AbortController()
    const pending = createBridgeFetch(ext.connect)(at('/api/slow'), { signal: controller.signal })
    await sentFrom(ext)
    controller.abort()

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(ext.port.sent.at(-1)).toEqual({ type: 'abort', id: ext.port.lastId })
  })

  it('rejects as a network error when the host cannot reach the daemon', async () => {
    const ext = new FakeExtension()
    const pending = createBridgeFetch(ext.connect)(at('/api/runtime/ping'))
    await sentFrom(ext)
    ext.port.reply({
      type: 'error',
      id: ext.port.lastId,
      reason: 'daemon-unreachable',
      message: 'no daemon is running',
    })
    await expect(pending).rejects.toThrow(TypeError)
  })

  it('errors a body the daemon stopped writing', async () => {
    const ext = new FakeExtension()
    const pending = createBridgeFetch(ext.connect)(at('/api/sync/stream'))
    await sentFrom(ext)
    const id = ext.port.lastId
    ext.port.reply({ type: 'head', id, status: 200, headers: {} })
    const body = (await pending).text()
    ext.port.reply({ type: 'error', id, reason: 'stream-failed', message: 'closed' })
    await expect(body).rejects.toThrow(TypeError)
  })

  it('errors a body whose chunk is not base64 rather than passing it off as complete', async () => {
    const ext = new FakeExtension()
    const pending = createBridgeFetch(ext.connect)(at('/api/sync/stream'))
    await sentFrom(ext)
    const id = ext.port.lastId
    ext.port.reply({ type: 'head', id, status: 200, headers: {} })
    const body = (await pending).text()
    ext.port.reply({ type: 'chunk', id, data: 'not base64!' })
    await expect(body).rejects.toThrow(TypeError)
    // The host is still streaming; dropping the request here alone would
    // leave it feeding chunks nobody reads.
    expect(ext.port.sent.at(-1)).toEqual({ type: 'abort', id })
  })

  // The host and the page ship separately, so a host newer than the page can
  // answer in a shape this page cannot read. A request whose answer is
  // dropped waits for ever, so what cannot be read ends the request it names.
  describe('a host message this page cannot read', () => {
    it('ends the request instead of leaving it waiting, whatever the host calls the failure', async () => {
      const ext = new FakeExtension()
      const pending = createBridgeFetch(ext.connect)(at('/api/x'))
      await sentFrom(ext)
      ext.port.reply({
        type: 'error',
        id: ext.port.lastId,
        reason: 'daemon-too-old',
        message: 'the daemon predates this call',
      })
      await expect(pending).rejects.toThrow(/daemon-too-old|the daemon predates this call/)
    })

    it('rejects a head whose shape it cannot read, saying the versions may differ', async () => {
      const ext = new FakeExtension()
      const pending = createBridgeFetch(ext.connect)(at('/api/x'))
      await sentFrom(ext)
      ext.port.reply({ type: 'head', id: ext.port.lastId, status: 799, headers: {} })
      await expect(pending).rejects.toThrow(/cannot read.*version/i)
    })

    it('errors the body of a stream a later message of unknown shape interrupts', async () => {
      const ext = new FakeExtension()
      const pending = createBridgeFetch(ext.connect)(at('/api/sync/stream'))
      await sentFrom(ext)
      const id = ext.port.lastId
      ext.port.reply({ type: 'head', id, status: 200, headers: {} })
      const body = (await pending).text()
      ext.port.reply({ type: 'chunk', id, data: 7 })
      await expect(body).rejects.toThrow(TypeError)
      expect(ext.port.sent.at(-1)).toEqual({ type: 'abort', id })
    })

    it('leaves a message that names no request of this page alone', async () => {
      const ext = new FakeExtension()
      const pending = createBridgeFetch(ext.connect)(at('/api/x'))
      await sentFrom(ext)
      const id = ext.port.lastId
      ext.port.reply({ type: 'unheard-of', id: 'someone-else' })
      ext.port.reply('not an object')
      ext.port.reply({ type: 'head', id, status: 200, headers: {} })
      ext.port.reply({ type: 'end', id })
      expect((await pending).status).toBe(200)
    })
  })

  describe('an extension that speaks another protocol', () => {
    it('refuses the request with the skew as the reason, and posts nothing', async () => {
      const ext = new FakeExtension()
      const bridgeFetch = createBridgeFetch(ext.connect, async () => 'update the extension')
      await expect(bridgeFetch(at('/api/x'))).rejects.toThrow('update the extension')
      expect(ext.ports.flatMap((p) => p.sent)).toEqual([])
    })

    it('is asked once per connection, and again after the extension loses its host', async () => {
      const ext = new FakeExtension()
      const skew = vi.fn(async () => null)
      const bridgeFetch = createBridgeFetch(ext.connect, skew)
      // Dropping the port fails these two, which is not what is asserted.
      const inFlight = [
        bridgeFetch(at('/api/a')).catch(() => undefined),
        bridgeFetch(at('/api/b')).catch(() => undefined),
      ]
      await vi.waitFor(() => expect(ext.port.sent).toHaveLength(2))
      expect(skew).toHaveBeenCalledTimes(1)

      ext.port.drop()
      await Promise.all(inFlight)
      bridgeFetch(at('/api/c')).catch(() => undefined)
      await vi.waitFor(() => expect(ext.ports).toHaveLength(2))
      expect(skew).toHaveBeenCalledTimes(2)
    })
  })

  // The extension relays frames unread, so it can vouch only for itself: the
  // host is a separate release (it ships in the npm package) and the page has
  // to ask it, or a host skew is reported as an extension one.
  describe('a native host that speaks another protocol', () => {
    const extensionAtThisProtocol = async () =>
      bridgeSkew({ version: '1.0.0', protocol: BRIDGE_PROTOCOL_VERSION })

    it('is refused by name when it is ahead of an extension that matches the page', async () => {
      const ext = new FakeExtension()
      ext.hostHello = { version: '9.9.9', protocol: BRIDGE_PROTOCOL_VERSION + 1 }
      const bridgeFetch = createBridgeFetch(ext.connect, extensionAtThisProtocol)

      const refusal = await bridgeFetch(at('/api/x')).catch((error: unknown) => error)

      expect(refusal).toBeInstanceOf(TypeError)
      expect(String(refusal)).toMatch(/native host \(version 9\.9\.9\)/)
      expect(String(refusal)).not.toMatch(/extension \(version/)
      expect(ext.ports.flatMap((p) => p.sent)).toEqual([])
    })

    it('is told to update the package it ships in when it is behind', async () => {
      const ext = new FakeExtension()
      ext.hostHello = { version: '0.0.1', protocol: BRIDGE_PROTOCOL_VERSION - 1 }
      const bridgeFetch = createBridgeFetch(ext.connect, extensionAtThisProtocol)

      await expect(bridgeFetch(at('/api/x'))).rejects.toThrow(
        /native host \(version 0\.0\.1\).*@kamiazya\/whiteboard-mcp/,
      )
    })

    it('is asked once per connection, and again after the extension loses its host', async () => {
      const ext = new FakeExtension()
      const bridgeFetch = createBridgeFetch(ext.connect)
      const inFlight = [
        bridgeFetch(at('/api/a')).catch(() => undefined),
        bridgeFetch(at('/api/b')).catch(() => undefined),
      ]
      await vi.waitFor(() => expect(ext.port.sent).toHaveLength(2))
      expect(ext.port.hellos).toHaveLength(1)

      ext.port.drop()
      await Promise.all(inFlight)
      bridgeFetch(at('/api/c')).catch(() => undefined)
      await vi.waitFor(() => expect(ext.ports).toHaveLength(2))
      await vi.waitFor(() => expect(ext.port.hellos).toHaveLength(1))
    })

    // A host built before the check drops the frame and never answers. It
    // relays fine, so silence is not a verdict: waiting out the clock and
    // carrying on is what keeps an old host usable.
    it('is not refused for staying silent, once the answer is given up on', async () => {
      vi.useFakeTimers()
      try {
        const ext = new FakeExtension()
        ext.hostHello = null
        const pending = createBridgeFetch(ext.connect)(at('/api/x'))
        await vi.advanceTimersByTimeAsync(5_000)
        expect(ext.port.sent).toEqual([expect.objectContaining({ type: 'request' })])
        const id = ext.port.lastId
        ext.port.reply({ type: 'head', id, status: 200, headers: {} })
        ext.port.reply({ type: 'end', id })
        expect((await pending).status).toBe(200)
      } finally {
        vi.useRealTimers()
      }
    })
  })

  // Lost host, missing host, crashed host: all arrive as the port closing.
  it('fails what is in flight when the extension loses its host, and reconnects after', async () => {
    const ext = new FakeExtension()
    const bridgeFetch = createBridgeFetch(ext.connect)
    const first = bridgeFetch(at('/api/a'))
    await sentFrom(ext)
    ext.port.reply({ type: 'disconnected', message: 'Specified native messaging host not found.' })
    ext.port.drop()
    await expect(first).rejects.toThrow(/native messaging host not found/)

    void bridgeFetch(at('/api/b'))
    await sentFrom(ext)
    expect(ext.ports).toHaveLength(2)
  })

  it('answers a status that carries no body without one', async () => {
    const ext = new FakeExtension()
    const pending = createBridgeFetch(ext.connect)(at('/api/x'), { method: 'DELETE' })
    await sentFrom(ext)
    const id = ext.port.lastId
    ext.port.reply({ type: 'head', id, status: 204, headers: {} })
    ext.port.reply({ type: 'end', id })
    const res = await pending
    expect(res.status).toBe(204)
    expect(res.body).toBeNull()
  })

  it('refuses a URL that is not the bridged daemon, and says the extension is missing', async () => {
    await expect(
      createBridgeFetch(new FakeExtension().connect)('https://example.com/api/x'),
    ).rejects.toThrow(TypeError)
    await expect(createBridgeFetch(() => null)(at('/api/x'))).rejects.toThrow(/extension/)
  })
})

describe('isBridgeDaemon', () => {
  it('names the bridge by its address alone', () => {
    expect(isBridgeDaemon(BRIDGE_DAEMON_BASE_URL)).toBe(true)
    expect(isBridgeDaemon('http://127.0.0.1:3099')).toBe(false)
    expect(isBridgeDaemon('not a url')).toBe(false)
  })
})

/** Waits until the page has put a message on the newest port. */
async function sentFrom(ext: FakeExtension): Promise<void> {
  await vi.waitFor(() => expect(ext.ports.at(-1)?.sent.length ?? 0).toBeGreaterThan(0))
}
