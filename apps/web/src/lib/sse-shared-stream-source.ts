/**
 * An SseStreamSource backed by the SharedWorker, so every tab in the profile
 * reads one SSE stream per daemon origin instead of one per canvas.
 *
 * Falls back to `null` where SharedWorker is unavailable (Chrome on Android,
 * and some embedded webviews), and for an origin whose worker failed to load.
 * The caller then lets SseBackend open its own stream — correct, just without
 * the cross-tab sharing.
 */
import type {
  DocListener,
  SseStreamSource,
} from '@kamiazya/whiteboard-daemon-client/sse-stream-hub'
import { base64ToBytes, bytesToBase64 } from '@kamiazya/whiteboard-model'
import { isBridgeDaemon } from './bridge-address.js'
import {
  postWorkerRequest,
  type SseWorkerEvent,
  sseWorkerEventSchema,
} from './sse-shared-worker-protocol.js'

const sources = new Map<string, { source: SseStreamSource; port: MessagePort }>()

/**
 * Origins whose worker failed to load. Remembered for the page's lifetime
 * because what makes one fail — a chunk missing from the deploy, a CSP
 * refusal — fails a fresh worker the same way, so this origin takes the
 * own-stream path from then on.
 */
const failedOrigins = new Set<string>()
const failureListeners = new Set<() => void>()

/** Whether this origin's worker failed, so a caller built on it should rebuild. */
export function sharedStreamFailed(baseUrl: string): boolean {
  return failedOrigins.has(baseUrl)
}

/**
 * Told when a worker fails. Its source is dead from then on — every listener
 * cut off, every read rejected — so a caller holding one rebuilds, and the
 * rebuild opens its own stream.
 */
export function subscribeSharedStreamFailure(listener: () => void): () => void {
  failureListeners.add(listener)
  return () => {
    failureListeners.delete(listener)
  }
}

/** One tab waiting on a snapshot: answered with the state, or told the read failed. */
interface SnapshotWaiter {
  resolve(bytes: Uint8Array): void
  reject(reason: Error): void
}

/**
 * Hands a worker's snapshot reply to everyone waiting on that document. No
 * bytes at all is the worker saying its own read of the daemon failed, and it
 * reaches the waiters as a rejection — how the hub reports a failed read — so
 * a caller has one way to learn a read failed whichever source it holds.
 */
function answerSnapshot(
  snapshotWaiters: Map<string, Set<SnapshotWaiter>>,
  doc: string,
  snapshot: string,
): void {
  const waiters = snapshotWaiters.get(doc)
  if (!waiters) return
  if (snapshot === '') {
    snapshotWaiters.delete(doc)
    const failed = new Error(`the worker could not read the document: ${doc}`)
    for (const waiter of waiters) waiter.reject(failed)
    return
  }
  const bytes = base64ToBytes(snapshot)
  // Left waiting rather than resolved with nothing: the worker's next
  // snapshot for this document can still answer them.
  if (bytes === null) return
  snapshotWaiters.delete(doc)
  for (const waiter of waiters) waiter.resolve(bytes)
}

/**
 * The ONE inbound channel. Every byte a tab applies has been through the
 * worker's replica — ordered and deduplicated against the daemon's frames and
 * every sibling tab's pushes — so all tabs observe the same sequence.
 */
function deliverToListeners(
  set: ReadonlySet<DocListener>,
  evt: Exclude<ReturnType<typeof sseWorkerEventSchema.parse>, { type: 'snapshot' }>,
): void {
  if (evt.type === 'authority-update') {
    const bytes = base64ToBytes(evt.update)
    if (bytes === null) return
    for (const l of set) l.onUpdate(bytes)
    return
  }
  if (evt.type === 'status') {
    for (const l of set) l.onConnectionChange?.(evt.connected)
    return
  }
  if (evt.type === 'write-state' || evt.type === 'write-refused') {
    deliverWriteNews(set, evt)
    return
  }
  if (evt.type === 'auth-refused') {
    for (const l of set) l.onAuthRefused?.()
    return
  }
  for (const l of set) l.onMessage(evt.raw)
}

/** What the worker says of the writes a tab handed it. */
function deliverWriteNews(
  set: ReadonlySet<DocListener>,
  evt: Extract<SseWorkerEvent, { type: 'write-state' | 'write-refused' }>,
): void {
  if (evt.type === 'write-state') {
    for (const l of set) l.onWriteState?.(evt.landed)
  } else {
    for (const l of set) l.onWriteRefused?.(evt.refusal)
  }
}

/**
 * What a worker that failed to load leaves behind. Whoever is watching is told
 * they are not connected — the UI reads this to stop claiming a live daemon —
 * and a read waiting on the port rejects, as the contract says a read that
 * cannot be served does. The origin is remembered, and whoever follows
 * failures is told so it can rebuild.
 */
function retire(
  baseUrl: string,
  listeners: Map<string, Set<DocListener>>,
  snapshotWaiters: Map<string, Set<SnapshotWaiter>>,
): void {
  for (const set of listeners.values()) {
    for (const listener of set) listener.onConnectionChange?.(false)
  }
  listeners.clear()
  const failed = workerFailed(baseUrl)
  for (const waiters of snapshotWaiters.values()) {
    for (const waiter of waiters) waiter.reject(failed)
  }
  snapshotWaiters.clear()
  sources.delete(baseUrl)
  failedOrigins.add(baseUrl)
  for (const listener of failureListeners) listener()
}

const workerFailed = (baseUrl: string) =>
  new Error(`the shared worker for ${baseUrl} failed to load`)

export function createSharedSseStreamSource(baseUrl: string): SseStreamSource | null {
  if (typeof SharedWorker === 'undefined') return null
  // A worker has no `chrome.runtime`, so it cannot reach a daemon through the
  // extension (ADR-0050); the page opens that stream itself.
  if (isBridgeDaemon(baseUrl)) return null
  if (failedOrigins.has(baseUrl)) return null

  const cached = sources.get(baseUrl)
  if (cached) return cached.source

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
  /**
   * Tabs waiting on a snapshot, keyed by doc. Keyed rather than queued
   * because the worker's reply carries the doc and nothing else — two
   * concurrent requests for the same document share whichever state the
   * replica holds when it answers, which is exactly what they would have
   * gotten asking separately.
   */
  const snapshotWaiters = new Map<string, Set<SnapshotWaiter>>()
  const port = worker.port

  let dead = false

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
    if (dead) return
    dead = true
    retire(baseUrl, listeners, snapshotWaiters)
  }
  port.onmessage = (e: MessageEvent) => {
    const parsed = sseWorkerEventSchema.safeParse(e.data)
    if (!parsed.success) return
    const evt = parsed.data
    // Answered ahead of the listener gate below: a snapshot answers a
    // request, not a subscription, and a caller may ask for one with no
    // listener at all — gating it on one would leave that caller waiting
    // forever.
    if (evt.type === 'snapshot') {
      answerSnapshot(snapshotWaiters, evt.doc, evt.snapshot)
      return
    }
    const set = listeners.get(evt.doc)
    if (set) deliverToListeners(set, evt)
  }
  port.start()
  postWorkerRequest(port, { type: 'init', baseUrl })

  const source: SseStreamSource = {
    subscribe(doc, listener) {
      let set = listeners.get(doc)
      if (!set) {
        set = new Set()
        listeners.set(doc, set)
        // The worker refcounts across tabs; this port refcounts within the tab,
        // so it announces a document once however many documents here want it.
        postWorkerRequest(port, { type: 'subscribe', doc })
      }
      set.add(listener)
      return () => {
        const current = listeners.get(doc)
        if (!current) return
        current.delete(listener)
        if (current.size > 0) return
        listeners.delete(doc)
        postWorkerRequest(port, { type: 'unsubscribe', doc })
      }
    },
    sendMessage(doc, message) {
      postWorkerRequest(port, { type: 'control', doc, message })
    },
    push(doc, update) {
      // To the worker's replica, not to the daemon. The replica merges this
      // against everything it already has — the other tabs' work and the
      // daemon's — and is what carries the result onward in both directions,
      // so a tab posting to the daemon itself would be writing around the very
      // thing meant to order these writes.
      postWorkerRequest(port, { type: 'push', doc, update: bytesToBase64(update) })
    },
    snapshot(doc) {
      // From the worker's replica, not the daemon: the worker seeds itself
      // once per document and every later tab is answered from memory. The
      // worker replies even for a document nobody has (an empty snapshot),
      // and with no bytes when its own read of the daemon failed, which
      // rejects — so this settles rather than racing a timeout. `null` is
      // reserved for the hub implementation's 404, which has a daemon to ask.
      if (dead) return Promise.reject(workerFailed(baseUrl))
      return new Promise((resolve, reject) => {
        let waiters = snapshotWaiters.get(doc)
        if (!waiters) {
          waiters = new Set()
          snapshotWaiters.set(doc, waiters)
        }
        waiters.add({ resolve, reject })
        postWorkerRequest(port, { type: 'snapshot-request', doc })
      })
    },
  }

  // A port has no close event, so a navigating-away tab has to hand its claims
  // back explicitly or the worker keeps routing documents nobody is watching.
  globalThis.addEventListener?.('pagehide', () => {
    for (const doc of listeners.keys()) postWorkerRequest(port, { type: 'unsubscribe', doc })
    listeners.clear()
  })

  sources.set(baseUrl, { source, port })
  return source
}
