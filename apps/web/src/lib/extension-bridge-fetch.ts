/**
 * ADR-0050 decision 1: the hosted page reaches the local daemon through the
 * whiteboard extension, and the extension carries the daemon's existing HTTP
 * API. This is that transport shaped as `fetch`, so every call the app already
 * makes — and the SSE stream, read as a body — keeps its shape; only the
 * function it is handed changes.
 *
 * The page holds no credential: the native host attaches the daemon's own.
 */
import {
  type ExtensionToPage,
  extensionHelloReplySchema,
  extensionToPageSchema,
} from '@kamiazya/whiteboard-daemon-client/extension-bridge'
import { WHITEBOARD_EXTENSION_ID } from '@kamiazya/whiteboard-daemon-client/extension-names'
import { fromBase64, toBase64 } from '@kamiazya/whiteboard-daemon-client/sse-stream-hub'
import { BRIDGE_ORIGIN } from './bridge-address.js'
import type { BridgePort } from './extension-bridge-port.js'
import { connectThroughWindow, windowHello } from './extension-window-port.js'

interface ExtensionRuntime {
  connect(extensionId: string): BridgePort
  sendMessage(extensionId: string, message: unknown, reply: (response: unknown) => void): void
  readonly lastError?: unknown
}

/**
 * `chrome.runtime` as a page sees it — present only where the browser has an
 * extension that admits this origin. Firefox never gives a page one; there
 * the extension's content script relays over the window instead.
 */
function extensionRuntime(): ExtensionRuntime | null {
  const runtime = (globalThis as { chrome?: { runtime?: Partial<ExtensionRuntime> } }).chrome
    ?.runtime
  return typeof runtime?.connect === 'function' && typeof runtime.sendMessage === 'function'
    ? (runtime as ExtensionRuntime)
    : null
}

/** Whether the whiteboard extension is installed and admits this page. */
export function extensionPresent(timeoutMs = 1_500, signal?: AbortSignal): Promise<boolean> {
  const runtime = extensionRuntime()
  if (runtime === null) return windowHello(timeoutMs, signal)
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs)
    try {
      runtime.sendMessage(WHITEBOARD_EXTENSION_ID, { type: 'hello' }, (reply) => {
        clearTimeout(timer)
        resolve(extensionHelloReplySchema.safeParse(reply).success)
      })
    } catch {
      clearTimeout(timer)
      resolve(false)
    }
  })
}

/** Response statuses the Fetch spec gives no body. */
const NULL_BODY_STATUSES = new Set([101, 103, 204, 205, 304])

interface Pending {
  resolve: (response: Response) => void
  reject: (reason: unknown) => void
  /** The body's writer, once the head has arrived with a status that has one. */
  body?: ReadableStreamDefaultController<Uint8Array>
  /** Ends the request at the host when the reader stops reading. */
  cancel?: () => void
}

/**
 * A `fetch` that speaks through one extension port, opened on first use and
 * reopened after the extension loses its host.
 */
export function createBridgeFetch(connect: () => BridgePort | null): typeof globalThis.fetch {
  const pending = new Map<string, Pending>()
  let port: BridgePort | null = null

  const failAll = (reason: Error) => {
    for (const request of pending.values()) {
      request.reject(reason)
      request.body?.error(reason)
    }
    pending.clear()
    port = null
  }

  const onMessage = (raw: unknown) => {
    const parsed = extensionToPageSchema.safeParse(raw)
    if (!parsed.success) return
    const message = parsed.data
    if (message.type === 'disconnected') {
      failAll(new TypeError(`the whiteboard extension lost its host: ${message.message}`))
      return
    }
    settle(pending, message)
  }

  const open = (): BridgePort => {
    if (port !== null) return port
    const opened = connect()
    if (opened === null) throw new TypeError('the whiteboard extension is not available')
    opened.onMessage.addListener(onMessage)
    opened.onDisconnect.addListener(() => {
      if (port === opened) failAll(new TypeError('the whiteboard extension closed the connection'))
    })
    port = opened
    return opened
  }

  return async (input, init) => {
    const request = new Request(input, init)
    const url = new URL(request.url)
    if (url.origin !== BRIDGE_ORIGIN) {
      throw new TypeError(`the extension bridge carries only ${BRIDGE_ORIGIN}`)
    }
    request.signal.throwIfAborted()
    const body = await requestBody(request)
    return await sendRequest(open(), pending, request, body)
  }
}

/**
 * Posts one request on the bridge and answers when its head arrives. An
 * abort — the signal, or the reader cancelling the body — ends it at the host
 * too, so a closed SSE reader does not leave a stream open on the daemon.
 */
function sendRequest(
  bridge: BridgePort,
  pending: Map<string, Pending>,
  request: Request,
  body: string | undefined,
): Promise<Response> {
  const url = new URL(request.url)
  const id = crypto.randomUUID()
  return new Promise<Response>((resolve, reject) => {
    const entry: Pending = { resolve, reject }
    pending.set(id, entry)
    const abort = () => {
      if (!pending.delete(id)) return
      bridge.postMessage({ type: 'abort', id })
      reject(request.signal.reason)
      entry.body?.error(request.signal.reason)
    }
    request.signal.addEventListener('abort', abort, { once: true })
    // An abort while the body was being read has already fired.
    if (request.signal.aborted) {
      abort()
      return
    }
    entry.cancel = () => {
      if (pending.delete(id)) bridge.postMessage({ type: 'abort', id })
    }
    bridge.postMessage({
      type: 'request',
      id,
      method: request.method,
      path: `${url.pathname}${url.search}`,
      headers: Object.fromEntries(request.headers),
      ...(body === undefined ? {} : { body }),
    })
  })
}

async function requestBody(request: Request): Promise<string | undefined> {
  if (request.method === 'GET' || request.method === 'HEAD') return undefined
  const bytes = new Uint8Array(await request.arrayBuffer())
  return bytes.length === 0 ? undefined : toBase64(bytes)
}

/** Lands one host message on the request it belongs to. */
function settle(
  pending: Map<string, Pending>,
  message: Exclude<ExtensionToPage, { type: 'disconnected' }>,
): void {
  const request = pending.get(message.id)
  if (request === undefined) return
  switch (message.type) {
    case 'head': {
      if (NULL_BODY_STATUSES.has(message.status)) {
        request.resolve(new Response(null, { status: message.status, headers: message.headers }))
        return
      }
      const body = new ReadableStream<Uint8Array>({
        start: (controller) => {
          request.body = controller
        },
        cancel: () => request.cancel?.(),
      })
      request.resolve(new Response(body, { status: message.status, headers: message.headers }))
      return
    }
    case 'chunk':
      request.body?.enqueue(fromBase64(message.data))
      return
    case 'end':
      pending.delete(message.id)
      request.body?.close()
      return
    case 'error': {
      pending.delete(message.id)
      const reason = new TypeError(`${message.reason}: ${message.message}`)
      request.reject(reason)
      request.body?.error(reason)
    }
  }
}

/**
 * The page's one bridge: every daemon fetch addressed to
 * `BRIDGE_DAEMON_BASE_URL` shares this port.
 */
export const extensionBridgeFetch = createBridgeFetch(
  () => extensionRuntime()?.connect(WHITEBOARD_EXTENSION_ID) ?? connectThroughWindow(),
)
