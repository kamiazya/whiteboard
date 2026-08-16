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
import { fromBase64, SseStreamHub, toBase64 } from '@kamiazya/whiteboard-mcp/sse-stream-hub'
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
 * workspace and stays as light as the stream multiplexer it grew from.
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
  // Its own empty version, not `undefined`. A `from`-less update export is not
  // empty even for an untouched document, so treating "nothing acknowledged"
  // as "no baseline" makes every fresh subscription POST a header the daemon
  // has no use for. An empty baseline says the same thing and diffs to
  // nothing — and stays conservative once the replica has real state, since
  // the first write after that carries the whole document rather than
  // assuming the daemon already has what it happens to have sent us.
  ackedVersions.set(key, created.version())
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

/**
 * Whether the replica has been given the document's PRE-EXISTING state.
 *
 * The SSE stream carries only incremental updates from subscription onward —
 * the daemon's subscribe route registers routing and seeds nothing — so a
 * replica fed by the stream alone holds a document's history since this
 * worker booted, and a snapshot answered from it silently omits everything
 * older. The seed is one snapshot fetch per origin+document per worker
 * lifetime, done HERE so no tab pays it on the main thread and every later
 * tab is answered from memory.
 *
 * A daemon that answers 404 counts as seeded: empty IS that document's
 * state, and re-asking on every request would reintroduce the round trip
 * the replica exists to remove. A transport failure does NOT count, so the
 * next request retries.
 */
const seededDocs = new Set<string>()

function ensureSeeded(baseUrl: string, doc: string): void {
  const key = replicaKey(baseUrl, doc)
  if (seededDocs.has(key)) return
  // Marked before the await and unmarked on failure, not the other way
  // around: two callers racing this (a subscribe and a snapshot-request)
  // must not start two fetches.
  seededDocs.add(key)
  queueReplicaWork(async () => {
    try {
      const bytes = await hubFor(baseUrl).snapshot(doc)
      if (bytes === null || bytes.byteLength === 0) return
      const replica = replicaFor(baseUrl, doc)
      if (replica === undefined) return
      // Straight into the replica, NOT through ingest(): the seed is state
      // the daemon already holds, so it must never be written back
      // (scheduleWrite) nor broadcast as an authority-update to ports that
      // will fetch their own snapshot anyway. It also must not advance
      // ackedVersions here — the acked baseline moves only on a successful
      // write, and the seed is not a write.
      const before = replica.version()
      replica.import(bytes)
      // The daemon HAS this state by definition, so acknowledge it: without
      // this, the first tab push would re-send the entire seeded document.
      const acked = ackedVersions.get(key)
      if (acked !== undefined && acked.compare(before) === 0) {
        ackedVersions.set(key, replica.version())
      }
    } catch {
      seededDocs.delete(key)
    }
  })
}

function retainReplicaFeed(hub: SseStreamHub, baseUrl: string, doc: string): void {
  const key = replicaKey(baseUrl, doc)
  const existing = replicaFeeds.get(key)
  if (existing !== undefined) {
    existing.ports += 1
    return
  }
  ensureSeeded(baseUrl, doc)
  const off = hub.subscribe(doc, {
    // `null`: the daemon is the source, so nobody is excluded from the fan-out.
    onUpdate: (bytes) => ingest(baseUrl, doc, bytes, null),
    onMessage: () => {},
    onConnectionChange: (connected) => {
      // The stream coming back is the only signal a daemon that refused a
      // write is ready to take it, and the tab that made that edit may never
      // touch the canvas again — so without this the recovery would wait for a
      // second edit that never comes. A document with nothing outstanding
      // computes an empty delta and writes nothing, so this is free when there
      // is no work to redo.
      if (connected) scheduleWrite(baseUrl, doc)
    },
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
  // The seed is only current while the stream covers the document: releasing
  // the last claim deregisters the daemon's routing, so anything written in
  // the gap (an MCP tool, another device) never reaches this replica. The
  // next subscriber must pay one fresh snapshot fetch — the same price as a
  // first open — or it would be served the pre-gap state for the worker's
  // whole lifetime.
  seededDocs.delete(key)
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

/**
 * The replica version the daemon is known to have taken, per origin+document.
 *
 * Absent means "assume nothing", which sends the document's whole state on the
 * first write. That is deliberately the conservative direction: over-sending
 * costs bytes and Loro merges it away, while an acknowledged version that runs
 * AHEAD of what the daemon really holds loses an edit permanently — the
 * replica would never offer those ops again, and the tab that made them keeps
 * showing work that is stored nowhere.
 *
 * So this advances on a successful write and on nothing else. In particular it
 * does NOT advance when a daemon frame arrives: that frame says what the
 * daemon has of its OWN, and cannot speak for a tab's unpushed work sitting in
 * the same replica.
 */
const ackedVersions = new Map<string, ReturnType<InstanceType<LoroModule['LoroDoc']>['version']>>()

/**
 * One write at a time per document, so two in flight cannot land out of order
 * and let the later one's acknowledgement cover ops the earlier one never
 * delivered. Each link recomputes what is outstanding when it runs, which is
 * also what makes a failure self-healing: the bytes a refused write held are
 * still unacknowledged, so the next write picks them up without anything
 * having to buffer them.
 */
const writeChains = new Map<string, Promise<unknown>>()

function scheduleWrite(baseUrl: string, doc: string): void {
  const key = replicaKey(baseUrl, doc)
  const previous = writeChains.get(key) ?? Promise.resolve()
  const next = previous
    .then(async () => {
      const replica = replicaFor(baseUrl, doc)
      if (replica === undefined) return
      const acked = ackedVersions.get(key)
      if (acked === undefined) return
      // Read BEFORE the export and the await, for two different reasons: ops
      // that land while this request is in flight are not covered by it and
      // must not be marked acknowledged, and this is also the comparison that
      // decides whether there is anything to send at all.
      const at = replica.version()
      // Compared by VERSION, not by byte length. An update export is 22 bytes
      // of header even when it carries no ops, so a length check calls that a
      // write worth making and POSTs an empty body on every reconnect. `0` is
      // "the same state"; anything else, including the `undefined` Loro
      // returns for versions it cannot order, means send.
      if (at.compare(acked) === 0) return
      const pending = replica.export({ mode: 'update', from: acked })
      await hubFor(baseUrl).push(doc, pending)
      ackedVersions.set(key, at)
    })
    // Swallowed on purpose — there is no caller to tell. A refused write
    // leaves `ackedVersions` where it was, which IS the retry: the next write,
    // or the reconnect flush, recomputes the same outstanding bytes.
    .catch(() => undefined)
  writeChains.set(key, next)
}

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

/**
 * Merge bytes into a document's replica and tell the interested tabs what
 * actually changed.
 *
 * One function for both directions on purpose: a tab's push and a daemon
 * frame differ only in who must NOT be told (`from` — the sender, or nobody
 * when the daemon is the source). Everything else — merge, diff against what
 * the replica already had, fan out — is the same, and writing it twice is how
 * the two directions drift.
 *
 * The daemon direction is what makes `authority-update` a channel a client can
 * live on alone. A replica that only spoke when a tab pushed would leave a
 * forked tab silently missing every change that did not originate in a
 * sibling tab: an MCP tool writing to the canvas, another device, a restore.
 */
function ingest(baseUrl: string, doc: string, bytes: Uint8Array, from: MessagePort | null): void {
  queueReplicaWork(() => {
    const replica = replicaFor(baseUrl, doc)
    if (replica === undefined) return
    const before = replica.version()
    // Total by construction: a frame this replica cannot merge (a truncated
    // update, a future format) must not take the worker down for every tab
    // and every other document. The daemon remains the source it can re-sync
    // from.
    try {
      replica.import(bytes)
    } catch {
      return
    }
    // Only what the replica did not already have travels onward. Two things
    // depend on this rather than on it being an optimisation: a tab
    // re-pushing work a sibling already delivered costs no broadcast, and the
    // daemon's echo of a tab's OWN push diffs to nothing — which is what stops
    // the round trip from looping back out as authority state.
    // Tab-originated work goes on to the daemon; daemon-originated work is
    // already there. WHAT gets written is decided against the acknowledged
    // version rather than against the delta computed here — those are
    // different questions, and answering them with one value is what silently
    // dropped an edit the daemon refused.
    if (from !== null) scheduleWrite(baseUrl, doc)
    const merged = replica.export({ mode: 'update', from: before })
    if (merged.byteLength === 0) return
    const encoded = toBase64(merged)
    for (const [target, state] of ports) {
      if (target === from) continue
      // Two daemons can mint the same document id, so a tab paired with one of
      // them must never be handed the other's edits.
      if (state.baseUrl !== baseUrl) continue
      if (!state.subscriptions.has(doc)) continue
      target.postMessage({ type: 'authority-update', doc, update: encoded })
    }
  })
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
    // Seed first: a request can arrive before any subscribe (the backend
    // snapshots, then subscribes), and the replica queue serialises the seed
    // ahead of the answer below, so the reply carries the document's real
    // pre-existing state rather than only what this worker has seen.
    ensureSeeded(state.baseUrl, msg.doc)
    queueReplicaWork(() => {
      // An empty snapshot for a document the daemon does not know is the
      // right answer, not an error: forking from empty and letting updates
      // fill it in is the same path a first-ever open already takes.
      const snapshot = replicaFor(state.baseUrl, msg.doc)?.export({ mode: 'snapshot' })
      if (snapshot === undefined) return
      port.postMessage({ type: 'snapshot', doc: msg.doc, snapshot: toBase64(snapshot) })
    })
    return
  }

  if (msg.type === 'push') {
    // Excluded from its own fan-out: echoing an edit back to the tab that made
    // it would turn every stroke into a round trip through the tab that drew
    // it, which is the cost the fork model exists to avoid.
    ingest(state.baseUrl, msg.doc, fromBase64(msg.update), port)
    return
  }

  if (msg.type === 'subscribe') {
    if (state.subscriptions.has(msg.doc)) return
    retainReplicaFeed(hub, state.baseUrl, msg.doc)
    const off = hub.subscribe(msg.doc, {
      // No raw relay: a daemon frame reaches this port as an
      // `authority-update`, after the replica has ordered and deduplicated it
      // against everything else the worker knows. One inbound channel means
      // every tab observes the SAME sequence — the raw per-port relay was the
      // transition path while clients moved, and delivering both meant every
      // daemon frame crossed each port twice.
      onUpdate: () => {},
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
