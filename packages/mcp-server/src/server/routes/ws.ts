import type { WebSocket, RawData } from 'ws'
import type { IncomingMessage } from 'node:http'
import type { LoroDoc } from 'loro-crdt'
import type { ServerTextMessage } from '../../shared/ws-messages.js'
import { getDoc } from '../store/doc-cache.js'
import { saveCanvas } from '../store/canvas-store.js'
import type { VersionEntry } from '../store/version-store.js'
import { setBroadcastFn } from './canvas.js'
import {
  parseWsClientTextMessage,
  parseWsTargetFromRequestUrl,
} from './ws-validation.js'

// Centralized broadcaster. Typing the argument as ServerTextMessage makes
// every send site fail at compile time if the payload doesn't match the zod
// schema in shared/ws-messages.ts.
function broadcastTextMessage(
  workspaceId: string,
  slug: string,
  message: ServerTextMessage,
): void {
  const key = `${workspaceId}/${slug}`
  const clients = connections.get(key)
  if (!clients) return
  const raw = JSON.stringify(message)
  for (const ws of clients) {
    ws.send(raw)
  }
}

// Connection registry: key = "workspaceId/slug", value = Set<WebSocket>
const connections = new Map<string, Set<WebSocket>>()
const readyConnections = new Map<string, Set<WebSocket>>()
let runtimeTouch: () => void = () => {}

export function setRuntimeTouchFn(fn: () => void): void {
  runtimeTouch = fn
}

// WS broadcast helper that can exclude the sender.
// Exported so app.ts can wire it into the branches router checkoutTo flow.
export function broadcastLoroUpdate(
  workspaceId: string,
  slug: string,
  update: Uint8Array,
  excludeWs?: WebSocket,
): void {
  const key = `${workspaceId}/${slug}`
  const clients = connections.get(key)
  if (!clients) return
  for (const ws of clients) {
    if (ws !== excludeWs) {
      ws.send(update)
    }
  }
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

// Push version creation events to all WS clients on the canvas. The browser generates and uploads the thumbnail.
export function sendVersionCreated(
  workspaceId: string,
  slug: string,
  version: VersionEntry,
): void {
  broadcastTextMessage(workspaceId, slug, { type: 'version_created', version })
}

// Soft lock for restore: broadcast started/complete around reconcile.
// Clients block pointer events while started is active to reduce races with other peers.
// This is not an absolute CRDT lock, just a best-effort UX for the typically short restore window (<1s).
export function sendRestoreEvent(
  workspaceId: string,
  slug: string,
  phase: 'started' | 'complete',
  label?: string,
): void {
  if (phase === 'started') {
    broadcastTextMessage(workspaceId, slug, {
      type: 'restore_started',
      ...(label !== undefined ? { label } : {}),
    })
  } else {
    broadcastTextMessage(workspaceId, slug, { type: 'restore_complete' })
  }
}

// Notify all peers on the same key when HEAD changes. broadcastLoroUpdate
// already carries the state update; this is only a UI overlay signal.
export function sendHeadChanged(workspaceId: string, slug: string, head: string): void {
  broadcastTextMessage(workspaceId, slug, { type: 'head_changed', head })
}

// Injected from viewport.ts: handles viewport_response messages.
// viewport only sends an ACK, so matching on requestId is enough.
let resolveViewportFn: ((requestId: string) => void) | null = null
export function setResolveViewportFn(fn: (requestId: string) => void): void {
  resolveViewportFn = fn
}

// Send export_request to every WS client connected to a canvas. Used by export.ts.
export function sendExportRequest(
  workspaceId: string,
  slug: string,
  requestId: string,
  options?: { padding?: number; scale?: number; minFontPx?: number; frameId?: string },
): void {
  broadcastTextMessage(workspaceId, slug, {
    type: 'export_request',
    requestId,
    ...(options?.padding !== undefined ? { padding: options.padding } : {}),
    ...(options?.scale !== undefined ? { scale: options.scale } : {}),
    ...(options?.minFontPx !== undefined ? { minFontPx: options.minFontPx } : {}),
    ...(options?.frameId !== undefined ? { frameId: options.frameId } : {}),
  })
}

// Send viewport_request to every WS client connected to a canvas. Used by viewport.ts.
// The caller may provide any subset of mode / elementIds / animate / scrollX / scrollY / zoom.
// The browser-side useWhiteboardSync viewport_request handler applies them through excalidrawAPI.
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
  broadcastTextMessage(workspaceId, slug, {
    type: 'viewport_request',
    requestId,
    ...(params.mode !== undefined ? { mode: params.mode } : {}),
    ...(params.elementIds !== undefined ? { elementIds: params.elementIds } : {}),
    ...(params.animate !== undefined ? { animate: params.animate } : {}),
    ...(params.scrollX !== undefined ? { scrollX: params.scrollX } : {}),
    ...(params.scrollY !== undefined ? { scrollY: params.scrollY } : {}),
    ...(params.zoom !== undefined ? { zoom: params.zoom } : {}),
  })
}

// Return the number of WS clients connected to a canvas. Used for export.ts preflight checks.
export function getClientCount(workspaceId: string, slug: string): number {
  return connections.get(`${workspaceId}/${slug}`)?.size ?? 0
}

export function getReadyClientCount(workspaceId: string, slug: string): number {
  return readyConnections.get(`${workspaceId}/${slug}`)?.size ?? 0
}

export function getConnectionStats(): { connectedClients: number; readyClients: number } {
  const connectedClients = Array.from(connections.values()).reduce((sum, clients) => sum + clients.size, 0)
  const readyClients = Array.from(readyConnections.values()).reduce((sum, clients) => sum + clients.size, 0)
  return { connectedClients, readyClients }
}

// WS upgrade handler, called from server/index.ts.
// URL pattern: /ws/:workspaceId/:slug
// slug arrives URL-encoded because hierarchical paths may include "/".
// Example: /ws/abc/621%2Fheader -> workspaceId="abc", slug="621/header"
export async function handleWsUpgrade(req: IncomingMessage, ws: WebSocket): Promise<void> {
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

  ws.on('message', async (data: RawData, isBinary: boolean) => {
    runtimeTouch()
    if (!isBinary) {
      // text frame = JSON（export_response / viewport_response）
      const text = Buffer.isBuffer(data) ? data.toString() : String(data)
      const msg = parseWsClientTextMessage(text)
      if (msg === null) return
      if (msg.type === 'client_ready') {
        if (!readyConnections.has(key)) {
          readyConnections.set(key, new Set())
        }
        readyConnections.get(key)!.add(ws)
        return
      }
      if (msg.type === 'export_response') {
        resolveExportFn?.(msg.requestId, msg.data)
      } else if (msg.type === 'viewport_response') {
        resolveViewportFn?.(msg.requestId)
      }
      return
    }

    // binary frame = Loro update
    const bytes = Buffer.isBuffer(data)
      ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
      : data instanceof ArrayBuffer
        ? new Uint8Array(data)
        : new Uint8Array(Buffer.concat(data as Buffer[]))

    const currentDoc = await getDoc(workspaceId, slug)
    currentDoc.import(bytes)
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
        console.error('[ws] auto-version trigger failed:', err)
      })
  })

  ws.on('close', () => {
    runtimeTouch()
    const clients = connections.get(key)
    if (clients) {
      clients.delete(ws)
      if (clients.size === 0) {
        connections.delete(key)
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
