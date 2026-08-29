import type { IncomingMessage } from 'node:http'
import { SpanKind } from '@opentelemetry/api'
import type { LoroDoc } from 'loro-crdt'
import type { RawData, WebSocket } from 'ws'
import type { AgentActivityMessage, ServerTextMessage } from '../../shared/ws-messages.js'
import { getLogger } from '../log.js'
import { extractContextFromHeaders, getTracer } from '../observability/tracing.js'
import { ALL_AUTH_SCOPES, type AuthScope } from '../security/auth-strategy.js'
import {
  hasRequiredScopes,
  requiredScopesForClientTextMessage,
  WS_BINARY_UPDATE_REQUIRED_SCOPES,
} from '../security/ws-scope-registry.js'
import { evictWorkspaceDocs } from '../store/doc-cache.js'
import {
  evictWorkspaceDocCache,
  getDoc,
  getWorkspaceDoc,
  onWorkspaceDocUpdated,
  saveWorkspaceDoc,
  workspaceExists,
} from '../store/document-store.js'
import type { VersionEntry } from '../store/version-store.js'
import { withWorkspaceWriteLock } from '../store/workspace-lock.js'
import { resolveWorkspaceHandleToId } from '../workspace-handle.js'
import {
  setSyncSseHooks,
  sseBroadcastText,
  sseBroadcastTextToReady,
  sseBroadcastWorkspaceUpdate,
} from './sync-sse.js'
import { parseWsClientTextMessage, parseWsTargetFromRequestUrl } from './ws-validation.js'

// Connection registry: key = "workspaceId/path", value = Set<WebSocket>.
// The path names WHICH document the socket's text traffic (version_created,
// viewport, restore events) belongs to; binary traffic is workspace-
// granularity for every socket (see workspaceConnections).
const connections = new Map<string, Set<WebSocket>>()
const readyConnections = new Map<string, Set<WebSocket>>()

// Every socket, keyed by workspaceId: binary traffic is the workspace
// document's lineage, one contract for all clients. (The per-document
// binary contract — a projection's per-process lineage per socket — is
// retired; a workspace replica could never import those frames.)
const workspaceConnections = new Map<string, Set<WebSocket>>()

// The store-side funnel: every persisted workspace-document update — from a
// workspace-scope socket, an HTTP update at either granularity, an MCP tool
// save, a delete/rename, a restore — lands here once, with the exact bytes
// the store persisted. No sender exclusion: a sender importing its own ops
// back is a no-op by CRDT semantics.
onWorkspaceDocUpdated((workspaceId, update) => {
  const clients = workspaceConnections.get(workspaceId)
  if (clients) {
    for (const ws of clients) ws.send(update)
  }
  // The SSE transport is the same audience over a different pipe: a stream
  // subscribed at workspace granularity gets the same persisted bytes.
  sseBroadcastWorkspaceUpdate(workspaceId, update)
})

// Sticky viewport state per canvas. The MCP `viewport_set` tool only fires the
// `viewport_request` once and broadcasts to whoever is connected at that
// moment. Without this cache, a Playwright tab opening the same canvas a
// second later would land at default zoom/scroll and quietly mask that the
// fit/move request worked at all on the daemon-Chromium tab. Replaying on
// `client_ready` (not earlier) avoids racing the Excalidraw mount path.
const lastViewportRequestByDocument = new Map<string, string>()
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

function forEachClient(workspaceId: string, path: string, fn: (ws: WebSocket) => void): void {
  const clients = connections.get(`${workspaceId}/${path}`)
  if (!clients) return
  for (const ws of clients) fn(ws)
}

// Iterate only sockets that have signalled `client_ready`. Used for
// viewport_request: a pre-ready tab cannot apply the viewport yet, and
// the request is already replayed when the client emits `client_ready`,
// so broadcasting to non-ready sockets would just deliver the message
// twice.
function forEachReadyClient(workspaceId: string, path: string, fn: (ws: WebSocket) => void): void {
  const ready = readyConnections.get(`${workspaceId}/${path}`)
  if (!ready) return
  for (const ws of ready) fn(ws)
}

function broadcastTextMessage(workspaceId: string, path: string, message: ServerTextMessage): void {
  const raw = JSON.stringify(message)
  forEachClient(workspaceId, path, (ws) => ws.send(raw))
  sseBroadcastText(workspaceId, path, raw)
}

// The SSE transport needs the same viewport cache and pending-request resolver
// this module owns; injected rather than imported because ws.ts -> sync-sse.ts
// is already a one-way dependency.
setSyncSseHooks({
  getCachedViewportRequest: (key) => lastViewportRequestByDocument.get(key),
  resolveViewportRequest: (requestId) => resolveViewportFn?.(requestId),
})

// Injected from canvas.ts: auto-version trigger with built-in throttling.
// Called after WS binary messages; creates a new version and pushes it to the browser when the interval has elapsed.
type AutoVersionTrigger = (
  workspaceId: string,
  path: string,
  doc: LoroDoc,
) => Promise<VersionEntry | null>
var autoVersionTrigger: AutoVersionTrigger = () => Promise.resolve(null)
export function setAutoVersionTrigger(fn: AutoVersionTrigger): void {
  autoVersionTrigger = fn
}

// Test-only completion signal for the WS persistence path. Firing strictly
// after `saveDocument` resolves lets a real-socket test await a deterministic
// event instead of polling the filesystem/store — a no-op in production
// since nothing ever registers a callback.
let onPersistedForTests: ((workspaceId: string, path: string) => void) | undefined
export function setOnPersistedForTests(
  fn: ((workspaceId: string, path: string) => void) | undefined,
): void {
  onPersistedForTests = fn
}

export function sendVersionCreated(workspaceId: string, path: string, version: VersionEntry): void {
  broadcastTextMessage(workspaceId, path, { type: 'version_created', version })
}

// Soft lock for restore: clients block pointer events while started is active to
// reduce races with other peers during the typically short restore window (<1s).
export function sendRestoreEvent(
  workspaceId: string,
  path: string,
  phase: 'started' | 'complete',
  label?: string,
): void {
  const message: ServerTextMessage =
    phase === 'started'
      ? { type: 'restore_started', ...omitUndefined({ label }) }
      : { type: 'restore_complete' }
  broadcastTextMessage(workspaceId, path, message)
}

/**
 * Announce what an agent just did. Broadcast to every connected client, not
 * just ready ones, and never cached: a tab that connects later already has
 * the edit itself through the Loro snapshot, so replaying the announcement
 * would highlight a change it has always had.
 */
export function sendAgentActivity(
  workspaceId: string,
  path: string,
  payload: Omit<AgentActivityMessage, 'type'>,
): void {
  broadcastTextMessage(workspaceId, path, { type: 'agent_activity', ...payload })
}

export function sendHeadChanged(workspaceId: string, path: string, head: string): void {
  broadcastTextMessage(workspaceId, path, { type: 'head_changed', head })
}

let resolveViewportFn: ((requestId: string) => void) | null = null
export function setResolveViewportFn(fn: (requestId: string) => void): void {
  resolveViewportFn = fn
}

export function sendViewportRequest(
  workspaceId: string,
  path: string,
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
  lastViewportRequestByDocument.set(`${workspaceId}/${path}`, raw)
  // Send only to ready sockets. Pre-ready tabs cannot apply the viewport
  // yet AND will already get the cached request replayed when they
  // signal `client_ready`, so broadcasting to all sockets here would
  // deliver the message twice and re-trigger the pre-ready race the
  // cache was meant to fix.
  forEachReadyClient(workspaceId, path, (ws) => ws.send(raw))
  sseBroadcastTextToReady(workspaceId, path, raw)
}

// Return the number of WS clients connected to a canvas. Used for export.ts preflight checks.
export function getClientCount(workspaceId: string, path: string): number {
  return connections.get(`${workspaceId}/${path}`)?.size ?? 0
}

export function getReadyClientCount(workspaceId: string, path: string): number {
  return readyConnections.get(`${workspaceId}/${path}`)?.size ?? 0
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
// URL pattern: /ws/:workspaceId/:path
// path arrives URL-encoded because hierarchical paths may include "/".
// Example: /ws/abc/621%2Fheader -> workspaceId="abc", path="621/header"
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
  let path = ''
  try {
    const target = parseWsTargetFromRequestUrl(req.url, req.headers.host ?? 'localhost')
    workspaceId = target.workspaceId
    path = target.path
  } catch {
    ws.close()
    return
  }

  // Resolved before ANY use, and OUTSIDE the parse guard above so a registry
  // failure is not absorbed as a malformed address: `key` and both connection
  // registries below are keyed by this, and a socket registered under the
  // segment while its fan-out looks up the canonical id would go permanently
  // silent.
  workspaceId = await resolveWorkspaceHandleToId(workspaceId)

  const key = `${workspaceId}/${path}`

  // Before anything is registered or served: a workspace this daemon has
  // never heard of gets a refusal, not a phantom. getDoc() lazily creates an
  // empty doc for any key, so without this a connect to an unknown workspace
  // answered with an empty snapshot and a live socket — the tab shows
  // "Synced" while editing into memory the next restart discards. Stale
  // pairings make this reachable in practice: a browser keeps its paired
  // workspace id in localStorage, and ids outlive the install that minted
  // them. Workspace-level only — an unknown path in a registered workspace
  // keeps the lazy empty doc, which is how opening a just-deleted canvas
  // degrades. 4404 because RFC 6455 reserves 4000-4999 for application use
  // and no registered close code means "not found".
  if (!(await workspaceExists(workspaceId))) {
    ws.close(4404, `Workspace "${workspaceId}" not found`)
    return
  }

  // Register the connection: path-keyed for text traffic, workspace-keyed
  // for binary traffic.
  if (!connections.has(key)) {
    connections.set(key, new Set())
  }
  connections.get(key)!.add(ws)
  if (!workspaceConnections.has(workspaceId)) {
    workspaceConnections.set(workspaceId, new Set())
  }
  workspaceConnections.get(workspaceId)!.add(ws)
  runtimeTouch()

  // On connect, send the workspace document's snapshot as binary for the
  // initial load. Every socket rides the workspace lineage.
  const workspaceDoc = await getWorkspaceDoc(workspaceId)
  ws.send(workspaceDoc.export({ mode: 'snapshot' }))

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
      // text frame = JSON（viewport_response / ws_trace / client_ready）. An
      // export_response frame still parses and passes scope checks, but is
      // otherwise inert — the daemon stopped sending export_request in the
      // headless-only export slice (see shared/ws-messages.ts).
      const text = Buffer.isBuffer(data) ? data.toString() : String(data)
      const msg = parseWsClientTextMessage(text)
      if (msg === null) return
      if (!hasRequiredScopes(scopes, requiredScopesForClientTextMessage(msg.type))) {
        getLogger('ws').warning(
          { workspaceId, path, messageType: msg.type },
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
        const cachedViewport = lastViewportRequestByDocument.get(key)
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
      if (msg.type === 'viewport_response') {
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
        { workspaceId, path },
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
        'whiteboard.path': path,
        'whiteboard.update_bytes': bytes.byteLength,
      },
    } as const
    const wsSpan = parentCtx
      ? getTracer('whiteboard.ws').startSpan('ws.message.binary', spanStartOptions, parentCtx)
      : getTracer('whiteboard.ws').startSpan('ws.message.binary', spanStartOptions)
    try {
      // Import into the live workspace document under the same lock every
      // other mutation path holds. Fan-out to subscribers happens inside
      // saveWorkspaceDoc's listener, with the exact persisted bytes.
      const persisted = await withWorkspaceWriteLock(workspaceId, async () => {
        const workspaceDoc = await getWorkspaceDoc(workspaceId)
        // A second (or later) frame's handler can pass the `isClosing` check
        // above before this frame's await resolves — both were still false
        // at the top when they started. Recheck after the await so a frame
        // that lost that race does not import, persist, or close a socket
        // the earlier frame already tore down.
        if (isClosing) return false
        // `LoroDoc.import` throws synchronously (loro-crdt's wasm layer may
        // throw a non-Error value) whenever the bytes are not a valid Loro
        // update/snapshot. A write-scope credential is real authorization to
        // send edits, not a guarantee the bytes are well-formed CRDT data, so
        // this boundary must not be able to crash the daemon on one bad
        // frame. Treat it as a protocol violation: discard the frame, never
        // persist or broadcast it, and close 1003 (Unsupported Data) — the
        // socket was authorized, only this frame's payload was not decodable.
        try {
          workspaceDoc.import(bytes)
        } catch (err: unknown) {
          getLogger('ws').warning(
            { workspaceId, path, updateBytes: bytes.byteLength, err },
            'ws binary update rejected: malformed Loro import data',
          )
          closeSocket(1003, 'Malformed workspace update')
          return false
        }
        await saveWorkspaceDoc(workspaceId, workspaceDoc)
        // Every cached per-document projection of this workspace is now
        // stale; a stale one would diff old content back over this import
        // on its next save. Dropped inside the lock so no reader grabs a
        // stale projection between the import and the eviction.
        evictWorkspaceDocs(workspaceId)
        return true
      })
      if (!persisted) return
      // Isolated in its own try/catch: this hook exists only so tests can
      // await a deterministic "persisted" signal instead of polling. A
      // callback throwing must never be able to make an already-successful
      // save look like a persistence failure to real clients.
      try {
        onPersistedForTests?.(workspaceId, path)
      } catch (err: unknown) {
        getLogger('ws').warning(
          { workspaceId, path, err },
          'onPersistedForTests test hook threw; ignoring',
        )
      }
      // Auto-version for the socket's own path over the fresh projection.
      getDoc(workspaceId, path)
        .then((doc) => autoVersionTrigger(workspaceId, path, doc))
        .then((entry) => {
          if (entry) sendVersionCreated(workspaceId, path, entry)
        })
        .catch((err: unknown) => {
          getLogger('ws').error({ err: err as Error }, 'auto-version trigger failed')
        })
    } catch (err: unknown) {
      // A failure here is a server-side/state problem rather than client
      // misbehavior. The import above already mutated the cached live
      // workspace document; drop it (and every stale projection) so the next
      // access reloads from durable bytes. The sender's local doc still has
      // the edit applied, so leaving the socket open would let it keep
      // building on an edit the server never persisted — close 1011
      // (Internal Error) so the client reconnects and resyncs from the
      // persisted state instead.
      getLogger('ws').error({ workspaceId, path, err }, 'ws binary update failed')
      evictWorkspaceDocs(workspaceId)
      evictWorkspaceDocCache(workspaceId)
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
        // Intentionally keep `lastViewportRequestByDocument[key]` even when
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
    const scopeClients = workspaceConnections.get(workspaceId)
    if (scopeClients) {
      scopeClients.delete(ws)
      if (scopeClients.size === 0) {
        workspaceConnections.delete(workspaceId)
      }
    }
  })
}
