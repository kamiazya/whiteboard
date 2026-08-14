/**
 * An SseStreamSource backed by the SharedWorker, so every tab in the profile
 * reads one SSE stream per daemon origin instead of one per canvas.
 *
 * Falls back to `null` where SharedWorker is unavailable (Chrome on Android,
 * and some embedded webviews). The caller then lets SseBackend open its own
 * stream — correct, just without the cross-tab sharing.
 */
import type { DocListener, SseStreamSource } from '@kamiazya/whiteboard-mcp/sse-stream-hub'
import { fromBase64 } from '@kamiazya/whiteboard-mcp/sse-stream-hub'
import { sseWorkerEventSchema } from './sse-shared-worker-protocol.js'

const sources = new Map<string, { source: SseStreamSource; port: MessagePort }>()

export function createSharedSseStreamSource(
  baseUrl: string,
  token: string | undefined,
): SseStreamSource | null {
  if (typeof SharedWorker === 'undefined') return null

  const cached = sources.get(baseUrl)
  if (cached) {
    // The source is cached per origin but the pairing token is rotated under
    // it, so a caller arriving with a fresher credential hands it on rather
    // than silently reusing the one the worker was told about first.
    cached.port.postMessage({ type: 'init', baseUrl, token })
    return cached.source
  }

  let worker: SharedWorker
  try {
    worker = new SharedWorker(new URL('./sse-shared-worker.js', import.meta.url), {
      type: 'module',
      name: 'whiteboard-sse',
    })
  } catch {
    return null
  }

  const listeners = new Map<string, Set<DocListener>>()
  const port = worker.port

  // A module worker that fails to LOAD does not throw above — construction
  // succeeds and the failure arrives here instead. Without this the port is a
  // hole: every subscribe posts into it, nothing ever answers, and the caller
  // never learns it should have opened its own stream. That is a silent hang,
  // which is strictly worse than the missing cross-tab sharing the null return
  // degrades to.
  //
  // Verified as reachable-in-principle rather than observed: `type: 'module'`
  // shared workers load in Chromium, WebKit and Firefox (see
  // sse-shared-worker.browser.test.tsx), so today this fires only for a
  // missing chunk or a CSP refusal. It stays because a source of truth behind
  // this worker would make a silent hole much more expensive than it is now.
  worker.onerror = () => {
    // Tell whoever is watching that they are not connected — the UI reads this
    // to stop claiming a live daemon.
    for (const set of listeners.values()) {
      for (const listener of set) listener.onConnectionChange?.(false)
    }
    listeners.clear()
    // Evicted, so the next creation for this origin builds a fresh worker
    // rather than handing out the dead one from the cache forever.
    sources.delete(baseUrl)
  }
  port.onmessage = (e: MessageEvent) => {
    const parsed = sseWorkerEventSchema.safeParse(e.data)
    if (!parsed.success) return
    const evt = parsed.data
    const set = listeners.get(evt.doc)
    if (!set) return
    if (evt.type === 'update') {
      const bytes = fromBase64(evt.update)
      for (const l of set) l.onUpdate(bytes)
      return
    }
    if (evt.type === 'status') {
      for (const l of set) l.onConnectionChange?.(evt.connected)
      return
    }
    // The authority replica's own traffic. This source consumes the raw daemon
    // frames above; the fork-based client that consumes these is a separate
    // seam, and answering them here would deliver every update twice.
    if (evt.type === 'snapshot' || evt.type === 'authority-update') return
    for (const l of set) l.onMessage(evt.raw)
  }
  port.start()
  port.postMessage({ type: 'init', baseUrl, token })

  const source: SseStreamSource = {
    subscribe(doc, listener) {
      let set = listeners.get(doc)
      if (!set) {
        set = new Set()
        listeners.set(doc, set)
        // The worker refcounts across tabs; this port refcounts within the tab,
        // so it announces a document once however many canvases here want it.
        port.postMessage({ type: 'subscribe', doc })
      }
      set.add(listener)
      return () => {
        const current = listeners.get(doc)
        if (!current) return
        current.delete(listener)
        if (current.size > 0) return
        listeners.delete(doc)
        port.postMessage({ type: 'unsubscribe', doc })
      }
    },
    sendMessage(doc, message) {
      port.postMessage({ type: 'control', doc, message })
    },
  }

  // A port has no close event, so a navigating-away tab has to hand its claims
  // back explicitly or the worker keeps routing documents nobody is watching.
  globalThis.addEventListener?.('pagehide', () => {
    for (const doc of listeners.keys()) port.postMessage({ type: 'unsubscribe', doc })
    listeners.clear()
  })

  sources.set(baseUrl, { source, port })
  return source
}
