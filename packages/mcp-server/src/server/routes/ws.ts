import type { IncomingMessage } from 'node:http'
import { SpanKind } from '@opentelemetry/api'
import type { LoroDoc } from 'loro-crdt'
import type { RawData, WebSocket } from 'ws'
import type { ServerTextMessage } from '../../shared/ws-messages.js'
import { getLogger } from '../log.js'
import { extractContextFromHeaders, getTracer } from '../observability/tracing.js'
import { ALL_AUTH_SCOPES, type AuthScope } from '../security/auth-strategy.js'
import {
  hasRequiredScopes,
  requiredScopesForClientTextMessage,
  WS_BINARY_UPDATE_REQUIRED_SCOPES,
} from '../security/ws-scope-registry.js'
import { saveCanvas } from '../store/canvas-store.js'
import { evictDoc, getDoc } from '../store/doc-cache.js'
import type { VersionEntry } from '../store/version-store.js'
import { setBroadcastFn } from './canvas.js'
import { parseWsClientTextMessage, parseWsTargetFromRequestUrl } from './ws-validation.js'

// Connection registry: key = "workspaceId/slug", value = Set<WebSocket>
const connections = new Map<string, Set<WebSocket>>()
const readyConnections = new Map<string, Set<WebSocket>>()

// Sticky viewport state per canvas. The MCP `viewport_set` tool only fires the
// `viewport_request` once and broadcasts to whoever is connected at that
// moment. Without this cache, a Playwright tab opening the same canvas a
// second later would land at default zoom/scroll and quietly mask that the
// fit/move request worked at all on the daemon-Chromium tab. Replaying on
// `client_ready` (not earlier) avoids racing the Excalidraw mount path.
const lastViewportRequestByCanvas = new Map<string, string>()
let runtimeTouch: () => void = () => {}

export function setRuntimeTouchFn(fn: () => void): void {
  runtimeTouch = fn
}

function omitUndefined<T extends object>(o: T): Partial<T> {
  const out: Partial<T> = {}
  for (const [k, v] of Object.entries(o) as Array<[keyof T, T[keyof T]]>) {
    if (v !== undefined) out[k] = v
  }
  return out
}

function forEachClient(workspaceId: string, slug: string, fn: (ws: WebSocket) => void): void {
  const clients = connections.get(`${workspaceId}/${slug}`)
  if (!clients) return
  for (const ws of clients) fn(ws)
}

// Iterate only sockets that have signalled `client_ready`. Used for
// viewport_request: a pre-ready tab cannot apply the viewport yet, and
// the request is already replayed when the client emits `client_ready`,
// so broadcasting to non-ready sockets would just deliver the message
// twice.
function forEachReadyClient(workspaceId: string, slug: string, fn: (ws: WebSocket) => void): void {
  const ready = readyConnections.get(`${workspaceId}/${slug}`)
  if (!ready) return
  for (const ws of ready) fn(ws)
}

function broadcastTextMessage(workspaceId: string, slug: string, message: ServerTextMessage): void {
  const raw = JSON.stringify(message)
  forEachClient(workspaceId, slug, (ws) => ws.send(raw))
}

// Exported so app.ts can wire it into the branches router checkoutTo flow.
export function broadcastLoroUpdate(
  workspaceId: string,
  slug: string,
  update: Uint8Array,
  excludeWs?: WebSocket,
): void {
  forEachClient(workspaceId, slug, (ws) => {
    if (ws !== excludeWs) ws.send(update)
  })
}

// Set the broadcastFn used by canvas.ts.
setBroadcastFn(broadcastLoroUpdate)

// Injected from export.ts: handles export_response messages.
let resolveExportFn: ((requestId: string, data: string) => void) | null = null
export function setResolveExportFn(fn: (requestId: string, data: string) => void): void {
  resolveExportFn = fn
}

// Injected from canvas.ts: auto-version trigger with built-in throttling.
// Called after WS binary messages; creates a new version and pushes it to the browser when the interval has elapsed.
type AutoVersionTrigger = (
  workspaceId: string,
  slug: string,
  doc: LoroDoc,
) => Promise<VersionEntry | null>
var autoVersionTrigger: AutoVersionTrigger = () => Promise.resolve(null)
export function setAutoVersionTrigger(fn: AutoVersionTrigger): void {
  autoVersionTrigger = fn
}

export function sendVersionCreated(workspaceId: string, slug: string, version: VersionEntry): void {
  broadcastTextMessage(workspaceId, slug, { type: 'version_created', version })
}

// Soft lock for restore: clients block pointer events while started is active to
// reduce races with other peers during the typically short restore window (<1s).
export function sendRestoreEvent(
  workspaceId: string,
  slug: string,
  phase: 'started' | 'complete',
  label?: string,
): void {
  const message: ServerTextMessage =
    phase === 'started'
      ? { type: 'restore_started', ...omitUndefined({ label }) }
      : { type: 'restore_complete' }
  broadcastTextMessage(workspaceId, slug, message)
}

export function sendHeadChanged(workspaceId: string, slug: string, head: string): void {
  broadcastTextMessage(workspaceId, slug, { type: 'head_changed', head })
}

let resolveViewportFn: ((requestId: string) => void) | null = null
export function setResolveViewportFn(fn: (requestId: string) => void): void {
  resolveViewportFn = fn
}

export function sendExportRequest(
  workspaceId: string,
  slug: string,
  requestId: string,
  options: {
    padding?: number
    scale?: number
    minFontPx?: number
    frameId?: string
    theme?: 'light' | 'dark'
  } = {},
): void {
  broadcastTextMessage(workspaceId, slug, {
    type: 'export_request',
    requestId,
    ...omitUndefined(options),
  })
}

export function sendViewportRequest(
  workspaceId: string,
  slug: string,
  requestId: string,
  params: {
    mode?: 'fit' | 'move'
    elementIds?: string[]
    animate?: boolean
    scrollX?: number
    scrollY?: number
    zoom?: number
  } = {},
): void {
  const message = {
    type: 'viewport_request' as const,
    requestId,
    ...omitUndefined(params),
  }
  // Pre-serialise once: the broadcast and the later replay-on-client_ready
  // both ship the same bytes, and JSON.stringify is the only allocation that
  // needs to happen at viewport_set time.
  const raw = JSON.stringify(message)
  lastViewportRequestByCanvas.set(`${workspaceId}/${slug}`, raw)
  // Send only to ready sockets. Pre-ready tabs cannot apply the viewport
  // yet AND will already get the cached request replayed when they
  // signal `client_ready`, so broadcasting to all sockets here would
  // deliver the message twice and re-trigger the pre-ready race the
  // cache was meant to fix.
  forEachReadyClient(workspaceId, slug, (ws) => ws.send(raw))
}

// Return the number of WS clients connected to a canvas. Used for export.ts preflight checks.
export function getClientCount(workspaceId: string, slug: string): number {
  return connections.get(`${workspaceId}/${slug}`)?.size ?? 0
}

export function getReadyClientCount(workspaceId: string, slug: string): number {
  return readyConnections.get(`${workspaceId}/${slug}`)?.size ?? 0
}

export function getConnectionStats(): { connectedClients: number; readyClients: number } {
  const connectedClients = Array.from(connections.values()).reduce(
    (sum, clients) => sum + clients.size,
    0,
  )
  const readyClients = Array.from(readyConnections.values()).reduce(
    (sum, clients) => sum + clients.size,
    0,
  )
  return { connectedClients, readyClients }
}

// WS upgrade handler, called from server/index.ts.
// URL pattern: /ws/:workspaceId/:slug
// slug arrives URL-encoded because hierarchical paths may include "/".
// Example: /ws/abc/621%2Fheader -> workspaceId="abc", slug="621/header"
//
// `scopes` is the grant the upgrade authorized (see `authorizeWsUpgrade`).
// Defaults to the full grant set so every existing call site — which
// predates per-message scope enforcement — keeps its current behavior
// unchanged; callers that hold a narrower credential pass their real grant
// explicitly.
export async function handleWsUpgrade(
  req: IncomingMessage,
  ws: WebSocket,
  scopes: readonly AuthScope[] = ALL_AUTH_SCOPES,
): Promise<void> {
  let workspaceId = ''
  let slug = ''
  try {
    const target = parseWsTargetFromRequestUrl(req.url, req.headers.host ?? 'localhost')
    workspaceId = target.workspaceId
    slug = target.slug
  } catch {
    ws.close()
    return
  }

  const key = `${workspaceId}/${slug}`

  // Register the connection.
  if (!connections.has(key)) {
    connections.set(key, new Set())
  }
  connections.get(key)!.add(ws)
  runtimeTouch()

  // On connect, send the latest snapshot as binary for the initial load.
  const doc = await getDoc(workspaceId, slug)
  ws.send(doc.export({ mode: 'snapshot' }))

  // Holds the most recent W3C trace-context the client announced via
  // `ws_trace`. Consumed (and cleared) by the next binary frame so each
  // batch of edits is parented on the originating client span. Holding it
  // in closure scope keeps the per-canvas connection map untouched.
  let pendingTraceContext: ReturnType<typeof extractContextFromHeaders> | null = null

  // The connection's scopes are fixed at upgrade and cannot widen mid-session,
  // so a client that sends a message it lacks the scope for can never succeed
  // by retrying. Dropping the frame while leaving the socket open would let it
  // keep pushing rejected traffic; RFC 6455 1008 (Policy Violation) is the
  // close code for a message the peer is not permitted to send.
  // `ws.close()` only starts the closing handshake: frames the client already
  // put on the wire still reach this handler before the socket is torn down.
  // Without this flag a connection that just lost the socket for one message
  // could still have an in-scope follow-up frame (e.g. `client_ready`) take
  // effect on a socket that is on its way out.
  let isClosing = false
  // Every server-initiated close must set `isClosing` first so an already-queued
  // in-scope frame (e.g. `client_ready`) does not take effect on a socket that is
  // on its way out. Funnel all closes through here to keep that invariant in one place.
  function closeSocket(code: number, reason: string): void {
    isClosing = true
    ws.close(code, reason)
  }
  function closeForInsufficientScope(): void {
    closeSocket(1008, 'Insufficient scope')
  }

  ws.on('message', async (data: RawData, isBinary: boolean) => {
    if (isClosing) return
    runtimeTouch()
    if (!isBinary) {
      // text frame = JSON（export_response / viewport_response / ws_trace）
      const text = Buffer.isBuffer(data) ? data.toString() : String(data)
      const msg = parseWsClientTextMessage(text)
      if (msg === null) return
      if (!hasRequiredScopes(scopes, requiredScopesForClientTextMessage(msg.type))) {
        getLogger('ws').warning(
          { workspaceId, slug, messageType: msg.type },
          'ws message rejected: insufficient scope',
        )
        closeForInsufficientScope()
        return
      }
      if (msg.type === 'client_ready') {
        if (!readyConnections.has(key)) {
          readyConnections.set(key, new Set())
        }
        readyConnections.get(key)!.add(ws)
        // Replay the latest viewport_request to just-now-ready clients so
        // late joiners (Playwright tab opening after viewport_set fired,
        // reload, reconnect after WS hiccup) inherit the same fit / scroll
        // / zoom intent the daemon-Chromium tab already received.
        const cachedViewport = lastViewportRequestByCanvas.get(key)
        if (cachedViewport !== undefined) ws.send(cachedViewport)
        return
      }
      if (msg.type === 'ws_trace') {
        // Extract the W3C trace-context the client just announced. The
        // value lives until the next binary frame consumes it; if the
        // client sends another ws_trace before any binary frame, the
        // newer one wins.
        pendingTraceContext = extractContextFromHeaders({
          traceparent: msg.traceparent,
          tracestate: msg.tracestate,
        })
        return
      }
      if (msg.type === 'export_response') {
        resolveExportFn?.(msg.requestId, msg.data)
      } else if (msg.type === 'viewport_response') {
        resolveViewportFn?.(msg.requestId)
      }
      return
    }

    // binary frame = Loro update = a canvas mutation. Enforced here, not just
    // at upgrade: a socket authorized with only canvas:read must not be able
    // to import, persist, or broadcast a CRDT update just because it already
    // completed the handshake.
    if (!hasRequiredScopes(scopes, WS_BINARY_UPDATE_REQUIRED_SCOPES)) {
      getLogger('ws').warning(
        { workspaceId, slug },
        'ws binary update rejected: insufficient scope',
      )
      closeForInsufficientScope()
      return
    }

    const bytes = Buffer.isBuffer(data)
      ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
      : data instanceof ArrayBuffer
        ? new Uint8Array(data)
        : new Uint8Array(Buffer.concat(data as Buffer[]))

    // If the client announced a traceparent ahead of this frame, parent
    // the span on it so a UI-driven edit stitches end-to-end. Otherwise
    // open a parentless span so we still get a per-update timeline.
    const parentCtx = pendingTraceContext
    pendingTraceContext = null
    const spanStartOptions = {
      kind: SpanKind.SERVER,
      attributes: {
        'whiteboard.workspace_id': workspaceId,
        'whiteboard.slug': slug,
        'whiteboard.update_bytes': bytes.byteLength,
      },
    } as const
    const wsSpan = parentCtx
      ? getTracer('whiteboard.ws').startSpan('ws.message.binary', spanStartOptions, parentCtx)
      : getTracer('whiteboard.ws').startSpan('ws.message.binary', spanStartOptions)
    try {
      const currentDoc = await getDoc(workspaceId, slug)

      // `LoroDoc.import` throws synchronously (loro-crdt's wasm layer may
      // throw a non-Error value) whenever the bytes are not a valid Loro
      // update/snapshot. A write-scope credential is real authorization to
      // send edits, not a guarantee the bytes are well-formed CRDT data, so
      // this boundary must not be able to crash the daemon on one bad frame.
      // Treat it as a protocol violation: discard the frame, never persist
      // or broadcast it, and close — consistent with the 1008 scope-violation
      // close above, but 1003 (Unsupported Data) since the socket itself was
      // authorized, only this frame's payload was not decodable.
      try {
        currentDoc.import(bytes)
      } catch (err: unknown) {
        getLogger('ws').warning(
          { workspaceId, slug, updateBytes: bytes.byteLength, err },
          'ws binary update rejected: malformed Loro import data',
        )
        closeSocket(1003, 'Malformed canvas update')
        return
      }

      await saveCanvas(workspaceId, slug, currentDoc, { overwrite: true })
      broadcastLoroUpdate(workspaceId, slug, bytes, ws)

      // Trigger auto-versioning on the WS path as well, since browser edits primarily use it.
      // The trigger is throttled, so frequent edits stay safe.
      // On success, push version_created to all clients so the browser can generate and upload a thumbnail.
      autoVersionTrigger(workspaceId, slug, currentDoc)
        .then((entry) => {
          if (entry) sendVersionCreated(workspaceId, slug, entry)
        })
        .catch((err: unknown) => {
          getLogger('ws').error({ err: err as Error }, 'auto-version trigger failed')
        })
    } catch (err: unknown) {
      // A failure here (loadCanvas via getDoc, or saveCanvas) is a
      // server-side/state problem rather than client misbehavior. If the doc
      // was already mutated in-memory by a successful import above but
      // saveCanvas then rejected, evict the cache entry so the next getDoc
      // reloads from disk instead of silently keeping the unpersisted
      // mutation live. The sender's local doc still has the import applied,
      // so leaving the socket open would let it keep building on an edit the
      // server never persisted and other clients never received — close
      // 1011 (Internal Error) so the client reconnects and resyncs from the
      // persisted (evicted, disk-backed) state instead.
      getLogger('ws').error({ workspaceId, slug, err }, 'ws binary update failed')
      evictDoc(workspaceId, slug)
      closeSocket(1011, 'Failed to persist canvas update')
    } finally {
      wsSpan.end()
    }
  })

  ws.on('close', () => {
    runtimeTouch()
    const clients = connections.get(key)
    if (clients) {
      clients.delete(ws)
      if (clients.size === 0) {
        connections.delete(key)
        // Intentionally keep `lastViewportRequestByCanvas[key]` even when
        // the connection count hits zero. A reload (Playwright or anyone)
        // closes the old WS before the new WS opens, so clearing here
        // would defeat the whole point of cache-and-replay. The cache
        // tops out at one short string per canvas, so the leak is
        // negligible; the next viewport_set overwrites the entry.
      }
    }
    const readyClients = readyConnections.get(key)
    if (readyClients) {
      readyClients.delete(ws)
      if (readyClients.size === 0) {
        readyConnections.delete(key)
      }
    }
  })
}
