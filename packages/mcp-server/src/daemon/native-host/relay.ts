/**
 * ADR-0050 decision 1: the native messaging host. The browser starts it for
 * the whiteboard extension alone, and it relays the page's requests to the
 * daemon's owner-only socket (decision 2), attaching the daemon's credential
 * itself — the page never holds one.
 */
import { type IncomingHttpHeaders, type IncomingMessage, request } from 'node:http'
import type { Readable, Writable } from 'node:stream'
import {
  BRIDGE_CHUNK_BYTES,
  type HostToPage,
  type PageToHost,
  pageToHostSchema,
} from '@kamiazya/whiteboard-daemon-client/extension-bridge'
import { BRIDGE_PROTOCOL_VERSION } from '@kamiazya/whiteboard-daemon-client/extension-names'
import { PACKAGE_VERSION } from '../../shared/package-version.js'
import { encodeNativeMessage, readNativeMessages } from './native-messaging.js'

interface DaemonEndpoint {
  socketPath: string
  token: string
}

interface NativeHostOptions {
  input: Readable
  output: Writable
  /** Read per request: a restarted daemon has a new token. */
  resolveDaemon: () => Promise<DaemonEndpoint | null>
}

/**
 * What the page may say about its own request. Anything that names who is
 * asking or where — `authorization`, `cookie`, `origin`, `host` — is the
 * host's to set, and a header not listed here does not cross.
 */
const PAGE_HEADERS = new Set([
  'accept',
  'content-type',
  'if-match',
  'if-none-match',
  'last-event-id',
  'traceparent',
  'tracestate',
])

/** What the page may read of a response; a cookie is not the page's. */
const DROPPED_RESPONSE_HEADERS = new Set(['set-cookie'])

type Request = Extract<PageToHost, { type: 'request' }>

function pageHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).filter(([name]) => PAGE_HEADERS.has(name.toLowerCase())),
  )
}

function responseHeaders(headers: IncomingHttpHeaders): Record<string, string> {
  const kept: Record<string, string> = {}
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || DROPPED_RESPONSE_HEADERS.has(name)) continue
    kept[name] = Array.isArray(value) ? value.join(', ') : value
  }
  return kept
}

function requestIdOf(raw: unknown): string | null {
  if (typeof raw !== 'object' || raw === null || !('id' in raw)) return null
  const id = (raw as { id: unknown }).id
  return typeof id === 'string' && id.length > 0 && id.length <= 64 ? id : null
}

type Send = (message: HostToPage) => boolean

/**
 * A piece of body as base64 slices the browser accepts. Node hands a
 * response over in pieces far smaller than the cap, but nothing promises it.
 */
export function bodyChunks(piece: Buffer): string[] {
  const chunks: string[] = []
  for (let at = 0; at < piece.length; at += BRIDGE_CHUNK_BYTES) {
    chunks.push(piece.subarray(at, at + BRIDGE_CHUNK_BYTES).toString('base64'))
  }
  return chunks
}

export async function runNativeHost(options: NativeHostOptions): Promise<void> {
  // Registered before the daemon is looked up, so an abort that arrives
  // while the lookup is pending still reaches the request.
  const inFlight = new Map<string, AbortController>()
  const send: Send = (message) => options.output.write(encodeNativeMessage(message))

  await readNativeMessages(options.input, (raw) => {
    const parsed = pageToHostSchema.safeParse(raw)
    if (!parsed.success) {
      const id = requestIdOf(raw)
      const message = parsed.error.issues[0]?.message ?? 'invalid'
      if (id !== null) send({ type: 'error', id, reason: 'bad-request', message })
      return
    }
    const frame = parsed.data
    if (frame.type === 'hello') {
      send({ type: 'hello', version: PACKAGE_VERSION, protocol: BRIDGE_PROTOCOL_VERSION })
      return
    }
    if (frame.type === 'abort') {
      inFlight.get(frame.id)?.abort()
      inFlight.delete(frame.id)
      return
    }
    const controller = new AbortController()
    inFlight.set(frame.id, controller)
    const settled = () => inFlight.get(frame.id) === controller && inFlight.delete(frame.id)
    void relayRequest(frame, { ...options, send, signal: controller.signal, settled })
  })

  for (const controller of inFlight.values()) controller.abort()
}

interface RelayContext extends NativeHostOptions {
  send: Send
  signal: AbortSignal
  /** Ends this request's entry; false when it had already ended or was aborted. */
  settled: () => boolean
}

async function relayRequest(message: Request, context: RelayContext): Promise<void> {
  const { id } = message
  const daemon = await context.resolveDaemon()
  if (context.signal.aborted) return
  if (daemon === null) {
    context.settled()
    context.send({
      type: 'error',
      id,
      reason: 'daemon-unreachable',
      message: 'no daemon is running',
    })
    return
  }
  const headers = {
    ...pageHeaders(message.headers),
    authorization: `Bearer ${daemon.token}`,
    host: 'localhost',
  }
  const req = request(
    {
      socketPath: daemon.socketPath,
      method: message.method,
      path: message.path,
      headers,
      signal: context.signal,
    },
    (res) => relayResponse(id, res, context),
  )
  req.on('error', (err) => {
    // An abort ends the request on purpose, and the page asked for it.
    if (!context.settled()) return
    context.send({ type: 'error', id, reason: 'daemon-unreachable', message: err.message })
  })
  req.end(message.body === undefined ? undefined : Buffer.from(message.body, 'base64'))
}

function relayResponse(id: string, res: IncomingMessage, context: RelayContext): void {
  const { send } = context
  send({ type: 'head', id, status: res.statusCode ?? 502, headers: responseHeaders(res.headers) })
  res.on('data', (piece: Buffer) => {
    for (const data of bodyChunks(piece)) {
      if (!send({ type: 'chunk', id, data })) {
        res.pause()
        context.output.once('drain', () => res.resume())
      }
    }
  })
  res.on('end', () => {
    if (context.settled()) send({ type: 'end', id })
  })
  // A daemon that stops mid-response closes without an end; the page is
  // told, so a stream it is reading does not simply go quiet.
  res.on('error', () => {})
  res.on('close', () => {
    if (!context.settled()) return
    send({ type: 'error', id, reason: 'stream-failed', message: 'the daemon closed the response' })
  })
}
