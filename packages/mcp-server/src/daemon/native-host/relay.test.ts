/**
 * ADR-0050 decision 1: the native host relays the page's requests to the
 * daemon's owner-only socket. It is where the daemon's credential is attached,
 * so what the page sends is not trusted to carry or choose one.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import {
  BRIDGE_CHUNK_BYTES,
  type HostToPage,
  hostToPageSchema,
} from '@kamiazya/whiteboard-daemon-client/extension-bridge'
import { BRIDGE_PROTOCOL_VERSION } from '@kamiazya/whiteboard-daemon-client/extension-names'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PACKAGE_VERSION } from '../../shared/package-version.js'
import { encodeNativeMessage, readNativeMessages } from './native-messaging.js'
import { bodyChunks, runNativeHost } from './relay.js'

let dir: string
let daemon: Server | undefined
let socketPath: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wb-native-host-'))
  socketPath = join(dir, 'daemon.sock')
})
afterEach(async () => {
  daemon?.closeAllConnections()
  await new Promise<void>((resolve) => (daemon ? daemon.close(() => resolve()) : resolve()))
  daemon = undefined
  rmSync(dir, { recursive: true, force: true })
})

async function startDaemon(handler: Parameters<typeof createServer>[1]): Promise<void> {
  daemon = createServer(handler)
  await new Promise<void>((resolve) => daemon?.listen(socketPath, resolve))
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve) => {
    const parts: Buffer[] = []
    req.on('data', (part: Buffer) => parts.push(part))
    req.on('end', () => resolve(Buffer.concat(parts)))
  })
}

/** A browser on the other end of the host's stdio. */
function connectPage(
  resolveDaemon: Parameters<typeof runNativeHost>[0]['resolveDaemon'] = async () => ({
    socketPath,
    token: 'daemon-token',
  }),
) {
  const input = new PassThrough()
  const output = new PassThrough()
  const received: HostToPage[] = []
  const frames: Buffer[] = []
  output.on('data', (frame: Buffer) => frames.push(frame))
  void readNativeMessages(output, (message) => received.push(hostToPageSchema.parse(message)))
  const done = runNativeHost({ input, output, resolveDaemon })
  return {
    send: (message: unknown) => input.write(encodeNativeMessage(message)),
    close: () => input.end(),
    received,
    frames,
    done,
    until: (predicate: (messages: HostToPage[]) => boolean) =>
      vi.waitFor(() => expect(predicate(received)).toBe(true), { timeout: 5_000 }),
  }
}

const bodyOf = (messages: HostToPage[], id: string) =>
  Buffer.concat(
    messages.flatMap((m) =>
      m.type === 'chunk' && m.id === id ? [Buffer.from(m.data, 'base64')] : [],
    ),
  )

describe('runNativeHost', () => {
  // The extension relays frames unread, so the host is the only hop that can
  // say which protocol the frames after this one are in.
  it('answers a hello with the protocol it speaks and the package it ships in', async () => {
    const page = connectPage()

    page.send({ type: 'hello' })
    await page.until((m) => m.some((x) => x.type === 'hello'))

    expect(page.received).toEqual([
      { type: 'hello', version: PACKAGE_VERSION, protocol: BRIDGE_PROTOCOL_VERSION },
    ])
    page.close()
    await page.done
  })

  it('relays a request with the daemon credential it attaches itself', async () => {
    let seen: {
      method?: string
      url?: string
      headers?: IncomingMessage['headers']
      body?: Buffer
    } = {}
    await startDaemon(async (req, res) => {
      seen = { method: req.method, url: req.url, headers: req.headers, body: await readBody(req) }
      res.writeHead(201, { 'content-type': 'application/octet-stream', 'set-cookie': 'x=1' })
      res.end(Buffer.from([0, 1, 2, 255]))
    })
    const page = connectPage()

    page.send({
      type: 'request',
      id: 'r1',
      method: 'POST',
      path: '/api/workspaces/w/documents?x=1',
      headers: {
        'content-type': 'application/octet-stream',
        authorization: 'Bearer from-the-page',
        cookie: 'session=page',
        origin: 'https://evil.example',
        host: 'evil.example',
      },
      body: Buffer.from([9, 8, 7]).toString('base64'),
    })
    await page.until((m) => m.some((x) => x.type === 'end'))

    expect(seen.method).toBe('POST')
    expect(seen.url).toBe('/api/workspaces/w/documents?x=1')
    expect(seen.headers?.authorization).toBe('Bearer daemon-token')
    expect(seen.headers?.host).toBe('localhost')
    expect(seen.headers?.cookie).toBeUndefined()
    expect(seen.headers?.origin).toBeUndefined()
    expect(seen.headers?.['content-type']).toBe('application/octet-stream')
    expect([...(seen.body ?? [])]).toEqual([9, 8, 7])

    const head = page.received.find((m) => m.type === 'head')
    expect(head).toMatchObject({ id: 'r1', status: 201 })
    expect(head?.type === 'head' && head.headers['set-cookie']).toBeFalsy()
    expect([...bodyOf(page.received, 'r1')]).toEqual([0, 1, 2, 255])
  })

  // Chromium refuses a message from the host above 1 MB.
  // A header dropped from the allowlist breaks only the caller that sends it,
  // which no other test here does. Each is spelled here rather than read from
  // the host's own list, so the two cannot drift together.
  it('forwards each header the page may choose, in any case, and drops any other', async () => {
    const allowed = [
      'accept',
      'content-type',
      'if-match',
      'if-none-match',
      'last-event-id',
      'traceparent',
      'tracestate',
    ]
    let seen: IncomingMessage['headers'] = {}
    await startDaemon((req, res) => {
      seen = req.headers
      res.end('ok')
    })
    const page = connectPage()

    page.send({
      type: 'request',
      id: 'h1',
      method: 'GET',
      path: '/api/runtime/ping',
      headers: {
        ...Object.fromEntries(allowed.map((name) => [name.toUpperCase(), `page-${name}`])),
        'x-forwarded-for': '203.0.113.9',
        'proxy-authorization': 'Basic from-the-page',
      },
    })
    await page.until((m) => m.some((x) => x.type === 'end'))

    for (const name of allowed) expect(seen[name]).toBe(`page-${name}`)
    expect(seen['x-forwarded-for']).toBeUndefined()
    expect(seen['proxy-authorization']).toBeUndefined()
    page.close()
    await page.done
  })

  it('splits a large response into messages the browser accepts', async () => {
    const big = Buffer.alloc(3 * BRIDGE_CHUNK_BYTES + 17, 7)
    await startDaemon((_req, res) => res.end(big))
    const page = connectPage()

    page.send({ type: 'request', id: 'big', method: 'GET', path: '/api/big', headers: {} })
    await page.until((m) => m.some((x) => x.type === 'end'))

    expect(bodyOf(page.received, 'big').equals(big)).toBe(true)
    expect(page.received.filter((m) => m.type === 'chunk').length).toBeGreaterThan(3)
    for (const frame of page.frames) expect(frame.length).toBeLessThan(1024 * 1024)
  })

  it('cuts a piece larger than the cap into slices at most the cap', () => {
    const piece = Buffer.alloc(2 * BRIDGE_CHUNK_BYTES + 5, 3)
    const chunks = bodyChunks(piece).map((data) => Buffer.from(data, 'base64'))
    expect(chunks.map((chunk) => chunk.length)).toEqual([BRIDGE_CHUNK_BYTES, BRIDGE_CHUNK_BYTES, 5])
    expect(Buffer.concat(chunks).equals(piece)).toBe(true)
  })

  it('streams a response as it arrives, and an abort closes it at the daemon', async () => {
    let closedAtDaemon = false
    await startDaemon((req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write('event: ready\ndata: {}\n\n')
      req.on('close', () => {
        closedAtDaemon = true
      })
    })
    const page = connectPage()

    page.send({ type: 'request', id: 's', method: 'GET', path: '/api/sync/stream', headers: {} })
    await page.until((m) => bodyOf(m, 's').toString().includes('event: ready'))
    expect(page.received.some((m) => m.type === 'end')).toBe(false)

    page.send({ type: 'abort', id: 's' })
    await vi.waitFor(() => expect(closedAtDaemon).toBe(true))
  })

  it('closes what is in flight when the browser closes the port', async () => {
    let closedAtDaemon = false
    await startDaemon((req, res) => {
      res.writeHead(200)
      res.write('x')
      req.on('close', () => {
        closedAtDaemon = true
      })
    })
    const page = connectPage()
    page.send({ type: 'request', id: 's', method: 'GET', path: '/api/sync/stream', headers: {} })
    await page.until((m) => m.some((x) => x.type === 'chunk'))

    page.close()
    await page.done
    await vi.waitFor(() => expect(closedAtDaemon).toBe(true))
  })

  it('refuses a request outside the API, naming the id it was sent under', async () => {
    const page = connectPage()
    page.send({ type: 'request', id: 'r2', method: 'POST', path: '/mcp', headers: {} })
    await page.until((m) => m.length > 0)
    expect(page.received).toEqual([
      expect.objectContaining({ type: 'error', id: 'r2', reason: 'bad-request' }),
    ])
  })

  it('says the daemon is unreachable when none is recorded', async () => {
    const page = connectPage(async () => null)
    page.send({ type: 'request', id: 'r3', method: 'GET', path: '/api/runtime/ping', headers: {} })
    await page.until((m) => m.length > 0)
    expect(page.received).toEqual([
      expect.objectContaining({ type: 'error', id: 'r3', reason: 'daemon-unreachable' }),
    ])
  })
})
