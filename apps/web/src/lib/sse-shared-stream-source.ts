/**
 * An SseStreamSource backed by the SharedWorker, so every tab in the profile
 * reads one SSE stream per daemon origin instead of one per canvas.
 *
 * Falls back to `null` where SharedWorker is unavailable (Chrome on Android,
 * and some embedded webviews). The caller then lets SseBackend open its own
 * stream — correct, just without the cross-tab sharing.
 */
import type { DocListener, SseStreamSource } from '@kamiazya/whiteboard-mcp/sse-stream-hub'
import { sseWorkerEventSchema } from './sse-shared-worker-protocol.js'

function fromBase64(value: string): Uint8Array {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

const sources = new Map<string, SseStreamSource>()

export function createSharedSseStreamSource(
  baseUrl: string,
  token: string | undefined,
): SseStreamSource | null {
  if (typeof SharedWorker === 'undefined') return null

  const cached = sources.get(baseUrl)
  if (cached) return cached

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
  }

  // A port has no close event, so a navigating-away tab has to hand its claims
  // back explicitly or the worker keeps routing documents nobody is watching.
  globalThis.addEventListener?.('pagehide', () => {
    for (const doc of listeners.keys()) port.postMessage({ type: 'unsubscribe', doc })
    listeners.clear()
  })

  sources.set(baseUrl, source)
  return source
}
