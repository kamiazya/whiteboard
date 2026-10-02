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
  type BridgeMethod,
  bridgeMethodSchema,
  bridgeSkew,
  type ExtensionHello,
  type ExtensionHelloReply,
  type ExtensionToPage,
  extensionHelloReplySchema,
  extensionToPageSchema,
  type PageToHost,
} from '@kamiazya/whiteboard-daemon-client/extension-bridge'
import { WHITEBOARD_EXTENSION_ID } from '@kamiazya/whiteboard-daemon-client/extension-names'
import { base64ToBytes, bytesToBase64 } from '@kamiazya/whiteboard-model'
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

/** What the extension says of itself, or `null` when it is not there to ask. */
export function extensionHello(
  timeoutMs = 1_500,
  signal?: AbortSignal,
): Promise<ExtensionHelloReply | null> {
  const runtime = extensionRuntime()
  if (runtime === null) return windowHello(timeoutMs, signal)
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), timeoutMs)
    try {
      const hello: ExtensionHello = { type: 'hello' }
      runtime.sendMessage(WHITEBOARD_EXTENSION_ID, hello, (reply) => {
        clearTimeout(timer)
        const parsed = extensionHelloReplySchema.safeParse(reply)
        resolve(parsed.success ? parsed.data : null)
      })
    } catch {
      clearTimeout(timer)
      resolve(null)
    }
  })
}

/**
 * Why the extension that answers cannot carry this page's requests, or `null`
 * when it can — or when none answers, which opening the port reports in its
 * own words.
 */
async function extensionSkew(): Promise<string | null> {
  const reply = await extensionHello(1_500)
  return reply === null ? null : bridgeSkew(reply)
}

/**
 * How long the page waits for the host to say which protocol it speaks. A host
 * built before the question drops it and never answers, and it relays fine, so
 * the wait ends in carrying on rather than in a refusal.
 */
const HOST_HELLO_TIMEOUT_MS = 1_500

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
 * The native host's own protocol check, asked of it down the port once per
 * connection: the extension relays frames unread, so it can vouch only for
 * itself, and a host skew reported as an extension one sends the person to
 * the wrong update.
 */
function hostChecker() {
  let checked: Promise<string | null> | null = null
  let answered: ((reply: ExtensionHelloReply | null) => void) | null = null
  return {
    /** Why the host cannot carry this page's requests, or `null`. Asks on first use. */
    check(bridge: BridgePort): Promise<string | null> {
      checked ??= new Promise<string | null>((resolve) => {
        const timer = setTimeout(() => answered?.(null), HOST_HELLO_TIMEOUT_MS)
        answered = (reply) => {
          clearTimeout(timer)
          answered = null
          resolve(reply === null ? null : bridgeSkew(reply, 'host'))
        }
        bridge.postMessage({ type: 'hello' } satisfies PageToHost)
      })
      return checked
    },
    answer: (reply: ExtensionHelloReply): void => answered?.(reply),
    /** The port is gone: a question in flight is given up on, and the next port is asked afresh. */
    reset(): void {
      answered?.(null)
      checked = null
    },
  }
}

/**
 * A `fetch` that speaks through one extension port, opened on first use and
 * reopened after the extension loses its host.
 */
export function createBridgeFetch(
  connect: () => BridgePort | null,
  skew: () => Promise<string | null> = async () => null,
): typeof globalThis.fetch {
  const pending = new Map<string, Pending>()
  let port: BridgePort | null = null
  // Asked once per connection: the extension's protocol cannot change under
  // an open port, and a replaced extension drops it.
  let skewed: Promise<string | null> | null = null
  const host = hostChecker()
  const failAll = (reason: Error) => {
    skewed = null
    host.reset()
    for (const request of pending.values()) {
      request.reject(reason)
      request.body?.error(reason)
    }
    pending.clear()
    port = null
  }
  const onMessage = (raw: unknown) => receive(pending, raw, failAll, host.answer)

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
    const method = carriedMethod(request)
    request.signal.throwIfAborted()
    const body = await requestBody(request)
    skewed ??= skew()
    const incompatible = (await skewed) ?? (await host.check(open()))
    if (incompatible !== null) throw new TypeError(incompatible)
    return await sendRequest(open(), pending, request, method, body)
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
  method: BridgeMethod,
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
      method,
      path: `${url.pathname}${url.search}`,
      headers: Object.fromEntries(request.headers),
      ...(body === undefined ? {} : { body }),
    })
  })
}

function carriedMethod(request: Request): BridgeMethod {
  const method = bridgeMethodSchema.safeParse(request.method)
  if (!method.success) throw new TypeError(`the extension bridge does not carry ${request.method}`)
  return method.data
}

async function requestBody(request: Request): Promise<string | undefined> {
  if (request.method === 'GET' || request.method === 'HEAD') return undefined
  const bytes = new Uint8Array(await request.arrayBuffer())
  return bytes.length === 0 ? undefined : bytesToBase64(bytes)
}

/** Reads one message off the port and lands it on the request it belongs to. */
function receive(
  pending: Map<string, Pending>,
  raw: unknown,
  failAll: (reason: Error) => void,
  onHello: (reply: ExtensionHelloReply) => void,
): void {
  const parsed = extensionToPageSchema.safeParse(raw)
  if (!parsed.success) {
    abandonUnreadable(pending, raw)
    return
  }
  const message = parsed.data
  if (message.type === 'hello') {
    onHello(message)
    return
  }
  if (message.type === 'disconnected') {
    failAll(new TypeError(`the whiteboard extension lost its host: ${message.message}`))
    return
  }
  settle(pending, message)
}

/**
 * A host newer than this page can answer in a shape the page has no schema
 * for. Dropping it leaves the request it names waiting for ever, so the
 * request ends instead, and says why: the cause is a version difference,
 * which nothing else on the page can show.
 */
function abandonUnreadable(pending: Map<string, Pending>, raw: unknown): void {
  const id = typeof raw === 'object' && raw !== null && 'id' in raw ? raw.id : undefined
  const request = typeof id === 'string' ? pending.get(id) : undefined
  if (request === undefined) return
  const reason = new TypeError(
    'the whiteboard extension or its native host sent a message this page cannot read — one of them is probably a different version from this page: rebuild the extension, or update @kamiazya/whiteboard-mcp for the host',
  )
  request.reject(reason)
  request.body?.error(reason)
  // Forgets the request, and tells the host to stop working on an answer
  // nothing here will read.
  request.cancel?.()
}

/** Lands one host message on the request it belongs to. */
function settle(
  pending: Map<string, Pending>,
  message: Exclude<ExtensionToPage, { type: 'disconnected' | 'hello' }>,
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
    case 'chunk': {
      const chunk = base64ToBytes(message.data)
      if (chunk !== null) {
        request.body?.enqueue(chunk)
        return
      }
      // A body with a hole in it must not read as a complete one, and the
      // host is told so, or it keeps streaming into a request nothing reads.
      request.cancel?.()
      request.body?.error(new TypeError('the extension bridge sent a chunk that is not base64'))
      return
    }
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
  extensionSkew,
)
