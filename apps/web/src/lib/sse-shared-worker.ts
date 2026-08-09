/**
 * The SharedWorker that owns one SSE stream per daemon origin for the whole
 * browser profile.
 *
 * Sharing has to happen HERE rather than inside a page: browsers cap concurrent
 * HTTP/1.1 connections per origin at six, and the daemon is plain http where
 * browsers do not negotiate HTTP/2. A stream per tab would spend that budget on
 * sync alone and stall the daemon's own API once a few canvas tabs are open.
 *
 * This file must be a real same-origin module: the app's CSP declares
 * `worker-src 'self'`, which rejects a blob: worker.
 */
import { SseStreamHub } from '@kamiazya/whiteboard-mcp/sse-stream-hub'
import { createDaemonFetch } from './daemon-auth-fetch.js'
import { sseWorkerRequestSchema } from './sse-shared-worker-protocol.js'

interface PortState {
  baseUrl: string
  /** doc -> unsubscribe, so a port that closes releases only its own claims. */
  subscriptions: Map<string, () => void>
}

const hubs = new Map<string, SseStreamHub>()
const ports = new Map<MessagePort, PortState>()
/**
 * Latest credential per origin. A hub outlives the `init` that created it,
 * while a pairing session token is rotated under it — so the token is read at
 * request time rather than captured when the hub is built.
 */
const tokens = new Map<string, string | undefined>()

function hubFor(baseUrl: string): SseStreamHub {
  const existing = hubs.get(baseUrl)
  if (existing) return existing
  // The daemon credential is attached by the app's single fetch seam, not
  // here — a second place building the header is exactly what
  // daemon-auth-seam.test.ts exists to prevent.
  const hub = new SseStreamHub({
    fetch: createDaemonFetch(baseUrl, () => tokens.get(baseUrl)),
    baseUrl,
  })
  hubs.set(baseUrl, hub)
  return hub
}

function toBase64(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function handle(port: MessagePort, raw: unknown): void {
  const parsed = sseWorkerRequestSchema.safeParse(raw)
  if (!parsed.success) return
  const msg = parsed.data

  if (msg.type === 'init') {
    tokens.set(msg.baseUrl, msg.token)
    // Re-init is also how a rotated token arrives, so an existing port keeps
    // its subscription handles: replacing them would strand the claims it
    // already holds with nothing left able to release them.
    const existing = ports.get(port)
    if (existing?.baseUrl === msg.baseUrl) {
      hubFor(msg.baseUrl)
      return
    }
    ports.set(port, { baseUrl: msg.baseUrl, subscriptions: new Map() })
    hubFor(msg.baseUrl)
    return
  }

  const state = ports.get(port)
  // A subscribe before init has no origin to attach to; dropping it is right,
  // and the client always sends init first on the same port.
  if (!state) return
  const hub = hubs.get(state.baseUrl)
  if (!hub) return

  if (msg.type === 'control') {
    hub.sendMessage(msg.doc, msg.message)
    return
  }

  if (msg.type === 'subscribe') {
    if (state.subscriptions.has(msg.doc)) return
    const off = hub.subscribe(msg.doc, {
      onUpdate: (bytes) => {
        port.postMessage({ type: 'update', doc: msg.doc, update: toBase64(bytes) })
      },
      onMessage: (text) => {
        port.postMessage({ type: 'message', doc: msg.doc, raw: text })
      },
      onConnectionChange: (connected) => {
        port.postMessage({ type: 'status', doc: msg.doc, connected })
      },
    })
    state.subscriptions.set(msg.doc, off)
    return
  }

  const off = state.subscriptions.get(msg.doc)
  if (!off) return
  off()
  state.subscriptions.delete(msg.doc)
}

// Typed locally rather than via `/// <reference lib="webworker" />`: that
// directive applies to the whole program, and swapping the DOM globals for the
// worker ones changes type resolution in every other file in this app.
interface SharedWorkerConnectScope {
  onconnect: ((event: { ports: readonly MessagePort[] }) => void) | null
}
// `self`, not `globalThis`: a shared worker's connect handler belongs to the
// worker's own scope object. A host that runs the module with an injected
// scope — Vitest's worker polyfill, for one — sees an assignment on globalThis
// land somewhere else entirely, and the worker then silently never receives a
// connection.
;(self as unknown as SharedWorkerConnectScope).onconnect = (event) => {
  const port = event.ports[0]
  if (!port) return
  port.onmessage = (e: MessageEvent) => handle(port, e.data)
  port.start()
  // A port has no reliable close event, so releasing a refcount depends on the
  // client sending `unsubscribe` — which it does on backend disconnect and on
  // pagehide. A tab killed outright (crash, force quit) therefore leaves its
  // subscription until the worker itself goes away, which costs one document's
  // updates on an already-open stream, not a connection.
}
