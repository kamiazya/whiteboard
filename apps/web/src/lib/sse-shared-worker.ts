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
import { fromBase64, SseStreamHub } from '@kamiazya/whiteboard-mcp/sse-stream-hub'
import { createDaemonFetch } from './daemon-auth-fetch.js'
import { sseWorkerRequestSchema } from './sse-shared-worker-protocol.js'

/**
 * The worker's own replica of each subscribed document.
 *
 * It exists so the consistency question — what has arrived, in what order — is
 * answered where the daemon stream is read, once, instead of separately in
 * every tab. A tab forks from this rather than adopting it: Loro scopes undo
 * to a peer and will not revert another peer's operations, so tabs sharing one
 * peer would share one undo stack.
 *
 * Nothing here interprets the document. The replica merges opaque update bytes
 * and answers with opaque update bytes, which is why this file needs no
 * canvas-workspace and stays as light as the stream multiplexer it grew from.
 */
/**
 * Loro is imported DYNAMICALLY, and that is load-bearing rather than a style
 * choice. It is a WASM module, so a static import makes this whole module's
 * evaluation asynchronous — and a shared worker's `onconnect` must be
 * installed synchronously, or a tab that connects while the WASM is still
 * initialising is simply lost. Making it static broke every existing browser
 * test in this file at once, which is how cheaply that failure hides: nothing
 * throws, the port just never answers.
 *
 * Replica work is therefore queued behind `loroReady` instead of running
 * inline. The stream relay above does not wait for it — a tab reading raw
 * daemon frames keeps working whether or not the replica ever loads.
 *
 * A load that never arrives resolves to `undefined` rather than rejecting.
 * Degrading is the only sound answer for a worker no tab can restart: the
 * relay keeps working, `replicaFor` answers nothing, and the replica-backed
 * messages go unanswered instead of taking down every document in the worker.
 * Rejecting is also observably wrong — a shared worker outlives the page that
 * started it, so a chunk still loading when the environment goes away turns
 * into an unhandled rejection charged to whoever is left, which is how this
 * first showed up: 2094 tests passing and the run failing anyway on four
 * rejections raised after teardown.
 */
type LoroModule = typeof import('loro-crdt')
let loro: LoroModule | undefined
const loroReady: Promise<LoroModule | undefined> = import('loro-crdt').then(
  (module) => {
    loro = module
    return module
  },
  () => undefined,
)

/**
 * Every replica operation, in arrival order.
 *
 * Without this each handler awaited `loroReady` independently and resumed in
 * whatever order their microtasks happened to settle — a push followed
 * immediately by a snapshot-request answered from the state BEFORE the push,
 * which is the one ordering guarantee a client has any right to expect from
 * something calling itself an authority.
 */
let replicaQueue: Promise<unknown> = loroReady
function queueReplicaWork(work: () => unknown): void {
  // Returns nothing on purpose. Every caller here fires and forgets, so a
  // promise handed back would be a rejection nobody handles the moment any
  // work throws — the same shape as the load rejection above, and just as
  // invisible until a run fails with every test passing. Swallowing belongs
  // here rather than at four call sites that would each have to remember.
  replicaQueue = replicaQueue.then(work, work).catch(() => undefined)
}

/**
 * Keyed by ORIGIN and document, never by document alone.
 *
 * A document id is minted by one daemon and nothing makes it unique across
 * two of them, so a replica keyed on the id alone would let two configured
 * origins share state — and, through the fan-out below, let one origin's edit
 * reach the other's tabs. Every other piece of worker state is already
 * origin-scoped; this keeps the replica from being the exception.
 *
 * `\n` separates because it cannot occur in an origin.
 */
const replicaKey = (baseUrl: string, doc: string) => `${baseUrl}\n${doc}`

const replicas = new Map<string, InstanceType<LoroModule['LoroDoc']>>()

function replicaFor(baseUrl: string, doc: string): InstanceType<LoroModule['LoroDoc']> | undefined {
  if (loro === undefined) return undefined
  const key = replicaKey(baseUrl, doc)
  const existing = replicas.get(key)
  if (existing !== undefined) return existing
  const created = new loro.LoroDoc()
  replicas.set(key, created)
  return created
}

/**
 * The replica's own hub subscription, one per origin+document, refcounted by
 * the ports interested in it.
 *
 * It is separate from the ports' subscriptions because the replica belongs to
 * the WORKER, not to any tab: feeding it from each port's own listener meant
 * one daemon frame queued one WASM import per subscribed tab, all but the
 * first of them merging bytes the replica already had, and all of them ahead
 * of that tab's real work on the single replica queue.
 *
 * Refcounted rather than permanent because the hub closes a document's daemon
 * subscription when its last listener leaves — a feed that never released
 * would keep every document ever opened subscribed for the life of the worker.
 */
const replicaFeeds = new Map<string, { off: () => void; ports: number }>()

function retainReplicaFeed(hub: SseStreamHub, baseUrl: string, doc: string): void {
  const key = replicaKey(baseUrl, doc)
  const existing = replicaFeeds.get(key)
  if (existing !== undefined) {
    existing.ports += 1
    return
  }
  const off = hub.subscribe(doc, {
    onUpdate: (bytes) => importIntoReplica(baseUrl, doc, bytes),
    onMessage: () => {},
  })
  replicaFeeds.set(key, { off, ports: 1 })
}

function releaseReplicaFeed(baseUrl: string, doc: string): void {
  const key = replicaKey(baseUrl, doc)
  const feed = replicaFeeds.get(key)
  if (feed === undefined) return
  feed.ports -= 1
  if (feed.ports > 0) return
  replicaFeeds.delete(key)
  feed.off()
}

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

function importIntoReplica(baseUrl: string, doc: string, bytes: Uint8Array): void {
  queueReplicaWork(() => {
    // Total by construction: a frame this replica cannot merge (a truncated
    // update, a future format) must not take the worker down for every tab
    // and every other document. The daemon remains the source it can re-sync
    // from.
    try {
      replicaFor(baseUrl, doc)?.import(bytes)
    } catch {
      return
    }
  })
}

/**
 * To every port subscribed to `doc` ON THE SAME ORIGIN, except the one that
 * sent the work. Two daemons can mint the same document id, and a tab paired
 * with one of them must never be handed the other's edits.
 */
function broadcastAuthorityUpdate(
  baseUrl: string,
  doc: string,
  update: Uint8Array,
  from: MessagePort,
): void {
  const encoded = toBase64(update)
  for (const [target, state] of ports) {
    if (target === from) continue
    if (state.baseUrl !== baseUrl) continue
    if (!state.subscriptions.has(doc)) continue
    target.postMessage({ type: 'authority-update', doc, update: encoded })
  }
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
    // Re-pointing a port at a DIFFERENT origin is the other case, and the old
    // record's claims have to be released before it is dropped: the handles
    // live in the map about to be replaced, so anything still held there could
    // never be released again — a document subscribed on the daemon and a
    // replica fed forever, for a port that has moved on.
    if (existing) {
      for (const [doc, off] of existing.subscriptions) {
        off()
        releaseReplicaFeed(existing.baseUrl, doc)
      }
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

  if (msg.type === 'snapshot-request') {
    queueReplicaWork(() => {
      // An empty snapshot for a document nobody has opened yet is the right
      // answer, not an error: forking from empty and letting the daemon fill
      // it in is the same path a first-ever open already takes.
      const snapshot = replicaFor(state.baseUrl, msg.doc)?.export({ mode: 'snapshot' })
      if (snapshot === undefined) return
      port.postMessage({ type: 'snapshot', doc: msg.doc, snapshot: toBase64(snapshot) })
    })
    return
  }

  if (msg.type === 'push') {
    queueReplicaWork(() => {
      const replica = replicaFor(state.baseUrl, msg.doc)
      if (replica === undefined) return
      const before = replica.version()
      try {
        replica.import(fromBase64(msg.update))
      } catch {
        return
      }
      // Only what the replica did not already have travels onward, so a tab
      // re-pushing work another tab already delivered costs one import and no
      // broadcast. Loro merges are idempotent, but a broadcast is not free.
      const merged = replica.export({ mode: 'update', from: before })
      if (merged.byteLength === 0) return
      broadcastAuthorityUpdate(state.baseUrl, msg.doc, merged, port)
    })
    return
  }

  if (msg.type === 'subscribe') {
    if (state.subscriptions.has(msg.doc)) return
    retainReplicaFeed(hub, state.baseUrl, msg.doc)
    const off = hub.subscribe(msg.doc, {
      onUpdate: (bytes) => {
        // Relay only. The replica is fed by its own subscription above, once
        // per document rather than once per tab watching it. Both paths carry
        // the same frame for now: the raw one is what today's clients consume
        // and the replica is what forks will, and one of the two goes away
        // once every client has moved.
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
  releaseReplicaFeed(state.baseUrl, msg.doc)
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
