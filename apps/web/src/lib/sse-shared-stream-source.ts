/**
 * An SseStreamSource backed by the SharedWorker, so every tab in the profile
 * reads one SSE stream per daemon origin instead of one per canvas.
 *
 * Falls back to `null` where SharedWorker is unavailable (Chrome on Android,
 * and some embedded webviews). The caller then lets SseBackend open its own
 * stream — correct, just without the cross-tab sharing. A worker that fails
 * to load AFTER construction falls back inside the source instead: see
 * `retire`.
 */
import {
  type DocListener,
  SseStreamHub,
  type SseStreamSource,
} from '@kamiazya/whiteboard-daemon-client/sse-stream-hub'
import { base64ToBytes, bytesToBase64 } from '@kamiazya/whiteboard-model'
import { isBridgeDaemon } from './bridge-address.js'
import {
  postWorkerRequest,
  type SseWorkerEvent,
  sseWorkerEventSchema,
} from './sse-shared-worker-protocol.js'

/**
 * One source per origin, kept for the page's lifetime — including one whose
 * worker failed to load. What makes a worker fail (a chunk missing from the
 * deploy, a CSP refusal) fails a fresh worker the same way, so a failed
 * origin's source stays cached and keeps serving through the page's own
 * stream rather than trying another worker.
 */
const sources = new Map<string, SseStreamSource>()

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
 * One listener's subscription: what letting go of it does. That changes when
 * the worker fails, from releasing the worker's claim to releasing the page's
 * own stream, and the closure `subscribe` returned calls whichever it is.
 */
interface Claim {
  leave: () => void
}

/**
 * What this tab was last told of a document it holds, kept so a listener
 * joining after the first is told it too. The worker announces to a PORT, and
 * a tab subscribes its port to a document once, so a later listener in the
 * same tab is someone the worker never knew to tell.
 */
interface Relayed {
  connected?: boolean
  authRefused: boolean
  /** Only a failing write is state; one that landed is news nobody joining needs. */
  writeFailing: boolean
}

/** Records what `evt` says of its document, for a listener that joins later. */
function remember(relayed: Map<string, Relayed>, evt: WorkerNews): void {
  const prior = relayed.get(evt.doc) ?? { authRefused: false, writeFailing: false }
  if (evt.type === 'status') {
    // Routed again means served again: a refusal before it no longer describes the document.
    const authRefused = evt.connected ? false : prior.authRefused
    relayed.set(evt.doc, { ...prior, connected: evt.connected, authRefused })
  } else if (evt.type === 'auth-refused') {
    relayed.set(evt.doc, { ...prior, authRefused: true })
  } else if (evt.type === 'write-state') {
    relayed.set(evt.doc, { ...prior, writeFailing: !evt.landed })
  }
}

/** Tells a joining listener the state everyone already holding the document was told. */
function announceTo(listener: DocListener, state: Relayed | undefined): void {
  if (!state) return
  const { connected } = state
  if (connected !== undefined) tellEach([listener], (l) => l.onConnectionChange?.(connected))
  if (state.authRefused) tellEach([listener], (l) => l.onAuthRefused?.())
  if (state.writeFailing) tellEach([listener], (l) => l.onWriteState?.(false))
}

/** One listener's throw is its own: everyone after it is still told. */
function tellEach(set: readonly DocListener[], tell: (listener: DocListener) => void): void {
  for (const l of set) {
    try {
      tell(l)
    } catch {
      // A listener's own failure is not this source's to propagate.
    }
  }
}

type WorkerNews = Exclude<SseWorkerEvent, { type: 'snapshot' }>

/**
 * The ONE inbound channel. Every byte a tab applies has been through the
 * worker's replica — ordered and deduplicated against the daemon's frames and
 * every sibling tab's pushes — so all tabs observe the same sequence.
 */
function deliverToListeners(claims: ReadonlyMap<DocListener, Claim>, evt: WorkerNews): void {
  const set = [...claims.keys()]
  if (evt.type === 'authority-update') {
    const bytes = base64ToBytes(evt.update)
    if (bytes === null) return
    tellEach(set, (l) => l.onUpdate(bytes))
    return
  }
  if (evt.type === 'status') {
    tellEach(set, (l) => l.onConnectionChange?.(evt.connected))
    return
  }
  if (evt.type === 'write-state') {
    tellEach(set, (l) => l.onWriteState?.(evt.landed))
    return
  }
  if (evt.type === 'write-refused') {
    tellEach(set, (l) => l.onWriteRefused?.(evt.refusal))
    return
  }
  if (evt.type === 'auth-refused') {
    tellEach(set, (l) => l.onAuthRefused?.())
    return
  }
  tellEach(set, (l) => l.onMessage(evt.raw))
}

/**
 * What a worker that failed to load leaves behind. A read waiting on the port
 * rejects, as the contract says a read that cannot be served does. Every
 * listener moves to the page's own stream, whose subscribe tells it at once
 * that it is not routed — the drop it would see from any stream — and later
 * that it is routed again. A holder therefore recovers the way it recovers
 * from any drop, and none has to know a worker was ever involved.
 */
function retire(
  baseUrl: string,
  listeners: Map<string, Map<DocListener, Claim>>,
  snapshotWaiters: Map<string, Set<SnapshotWaiter>>,
  own: SseStreamHub,
): void {
  const failed = workerFailed(baseUrl)
  for (const waiters of snapshotWaiters.values()) {
    for (const waiter of waiters) waiter.reject(failed)
  }
  snapshotWaiters.clear()
  const live = [...listeners].flatMap(([doc, claims]) =>
    [...claims].map((c) => [doc, ...c] as const),
  )
  listeners.clear()
  for (const [doc, listener, claim] of live) {
    // The subscribe below tells the listener it is not routed before it
    // returns, and a listener may let go right there.
    let leftEarly = false
    claim.leave = () => {
      leftEarly = true
    }
    const leave = own.subscribe(doc, listener)
    if (leftEarly) leave()
    else claim.leave = leave
  }
}

/** What one tab's port holds while its worker is alive. */
interface PortHolding {
  listeners: ReadonlyMap<string, ReadonlyMap<DocListener, Claim>>
  snapshotWaiters: Map<string, Set<SnapshotWaiter>>
  relayed: Map<string, Relayed>
}

/** One event from the worker, to whoever in this tab it concerns. */
function receive(raw: unknown, { listeners, snapshotWaiters, relayed }: PortHolding): void {
  const parsed = sseWorkerEventSchema.safeParse(raw)
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
  const claims = listeners.get(evt.doc)
  if (!claims) return
  remember(relayed, evt)
  deliverToListeners(claims, evt)
}

const workerFailed = (baseUrl: string) =>
  new Error(`the shared worker for ${baseUrl} failed to load`)

/**
 * `fetch` is the page's daemon fetch, which the page's own stream reads
 * through if the worker fails to load. The first caller's is the one kept,
 * since the source is shared by every caller for the origin.
 */
export function createSharedSseStreamSource(
  baseUrl: string,
  fetch: typeof globalThis.fetch,
): SseStreamSource | null {
  if (typeof SharedWorker === 'undefined') return null
  // A worker has no `chrome.runtime`, so it cannot reach a daemon through the
  // extension (ADR-0050); the page opens that stream itself.
  if (isBridgeDaemon(baseUrl)) return null

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

  const listeners = new Map<string, Map<DocListener, Claim>>()
  /**
   * Tabs waiting on a snapshot, keyed by doc. Keyed rather than queued
   * because the worker's reply carries the doc and nothing else — two
   * concurrent requests for the same document share whichever state the
   * replica holds when it answers, which is exactly what they would have
   * gotten asking separately.
   */
  const snapshotWaiters = new Map<string, Set<SnapshotWaiter>>()
  /** Beside `listeners`, and let go with a document's last claim. */
  const relayed = new Map<string, Relayed>()
  const port = worker.port

  /** The page's own stream, once the worker has failed; every call goes to it from then on. */
  let own: SseStreamHub | null = null

  // A module worker that fails to LOAD does not throw above — construction
  // succeeds and the failure arrives here instead. Without this the port is a
  // hole: every subscribe posts into it, nothing ever answers, and the page
  // goes quiet with nothing to say why.
  //
  // Verified as reachable-in-principle rather than observed: `type: 'module'`
  // shared workers load in Chromium, WebKit and Firefox (see
  // sse-shared-worker.browser.test.tsx), so today this fires only for a
  // missing chunk or a CSP refusal. It stays because a source of truth behind
  // this worker would make a silent hole much more expensive than it is now.
  worker.onerror = () => {
    if (own !== null) return
    // Set before any listener hears of the drop, so whatever it asks of this
    // source in answer — a snapshot, a fresh subscribe — reaches the page's
    // stream rather than the dead port.
    own = new SseStreamHub({ fetch, baseUrl })
    retire(baseUrl, listeners, snapshotWaiters, own)
  }
  port.onmessage = (e: MessageEvent) => receive(e.data, { listeners, snapshotWaiters, relayed })
  port.start()
  postWorkerRequest(port, { type: 'init', baseUrl })

  /** Lets go of one listener's claim on the worker. */
  const leaveWorker = (doc: string, listener: DocListener) => {
    const current = listeners.get(doc)
    if (!current?.delete(listener)) return
    if (current.size > 0) return
    listeners.delete(doc)
    relayed.delete(doc)
    postWorkerRequest(port, { type: 'unsubscribe', doc })
  }

  const source: SseStreamSource = {
    subscribe(doc, listener) {
      if (own !== null) return own.subscribe(doc, listener)
      let claims = listeners.get(doc)
      if (!claims) {
        claims = new Map()
        listeners.set(doc, claims)
        // The worker refcounts across tabs; this port refcounts within the tab,
        // so it announces a document once however many documents here want it.
        postWorkerRequest(port, { type: 'subscribe', doc })
      }
      const claim = claims.get(listener) ?? { leave: () => leaveWorker(doc, listener) }
      claims.set(listener, claim)
      announceTo(listener, relayed.get(doc))
      return () => claim.leave()
    },
    sendMessage(doc, message) {
      if (own !== null) return own.sendMessage(doc, message)
      postWorkerRequest(port, { type: 'control', doc, message })
    },
    push(doc, update) {
      if (own !== null) return own.push(doc, update)
      // To the worker's replica, not to the daemon. The replica merges this
      // against everything it already has — the other tabs' work and the
      // daemon's — and is what carries the result onward in both directions,
      // so a tab posting to the daemon itself would be writing around the very
      // thing meant to order these writes.
      postWorkerRequest(port, { type: 'push', doc, update: bytesToBase64(update) })
    },
    snapshot(doc) {
      if (own !== null) return own.snapshot(doc)
      // From the worker's replica, not the daemon: the worker seeds itself
      // once per document and every later tab is answered from memory. The
      // worker replies even for a document nobody has (an empty snapshot),
      // and with no bytes when its own read of the daemon failed, which
      // rejects — so this settles rather than racing a timeout. `null` is
      // reserved for the hub implementation's 404, which has a daemon to ask.
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
    relayed.clear()
  })

  sources.set(baseUrl, source)
  return source
}
