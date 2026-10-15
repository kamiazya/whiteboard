/**
 * One fleet of layout workers for every surface that needs a laid-out scene.
 *
 * There are more of those than the editor's canvas: a document list's
 * thumbnails, a tree row's minimap, and a favicon all want the same pipeline,
 * and a markdown document's version of any of them needs real layout rather
 * than a shortcut. Running each on its own worker would mean several module
 * graphs and several font registrations, none of them sharing a warm worker.
 *
 * PRIORITY is what makes one fleet safe to share. The two shapes of work are
 * genuinely different — an editor commit is latency-bound and a list is
 * throughput-bound — so the pool orders by that rather than by arrival, and
 * holds a worker back from background work so an interactive request never
 * waits out a render nobody asked for.
 *
 * Requests are keyed by id so a caller can `cancel` one that stopped
 * mattering — the row scrolled away — and the slot goes to a row that is
 * actually on screen.
 */

import type { ResponseFor, WorkRequest } from './layout-worker-protocol.js'
import { attachThemeFaces } from './theme-fonts.js'

/** The part of `Worker` this pool uses; a test supplies its own. */
export interface PoolWorker {
  postMessage(request: unknown): void
  terminate(): void
  onmessage: ((event: { data: { id: number } }) => void) | null
  onerror?: ((event: unknown) => void) | null
}

/**
 * `interactive` is work a person is waiting on — the scene for the commit
 * they just made. `background` fills a surface they are looking at but did
 * not ask for a moment ago: a list of thumbnails. `idle` is work NOBODY is
 * waiting on, where arriving a second late is not noticed at all — the tab
 * favicon is the case it exists for.
 *
 * The distinction exists so ONE fleet can serve all three. Without it the
 * choice is between several fleets (several module graphs, several font
 * registrations, and no sharing of a warm worker) or a thumbnail list
 * sitting in front of the one latency a user actually feels.
 *
 * Two bands were not enough once a surface appeared that is genuinely below
 * a list: `background` already means "not what they asked for", but a list
 * is still something they are looking at, and an icon competing with it on
 * equal terms wins slots by arrival order.
 */
type LayoutPriority = 'interactive' | 'background' | 'idle'

/** Highest first. `nextRunnableIndex` walks this order. */
const PRIORITY_ORDER: readonly LayoutPriority[] = ['interactive', 'background', 'idle']

interface PoolControls {
  /** Abandons a request, whether queued or already in flight. */
  cancel(id: number): void
  dispose(): void
}

/**
 * The scheduling core, generic over the requests it accepts so the
 * scheduling can be exercised with bare `{ id }` fakes. All it knows of a
 * reply is that it echoes the request's id; what else the reply carries is
 * the worker's protocol, which `sharedLayoutWorkerPool` binds.
 */
export interface LayoutWorkerPool<Req extends { id: number }> extends PoolControls {
  /**
   * Resolves with the worker's reply for this request's `id`.
   * Defaults to `interactive`: an unlabelled caller is one that has not
   * thought about it, and quietly deprioritising it is the wrong default.
   */
  run(request: Req, priority?: LayoutPriority): Promise<{ id: number }>
}

type RequestOfType<T extends WorkRequest['type']> = Extract<WorkRequest, { type: T }>

/**
 * The fleet as senders see it: keyed on the request's discriminant rather
 * than on the request's own type, so the literal is checked against the
 * protocol member it names. A misspelled or renamed field — optional ones
 * included — is then a compile error at the sender, not a worker reading
 * `undefined` and degrading to the main thread.
 */
export interface ProtocolLayoutWorkerPool extends PoolControls {
  /** As `LayoutWorkerPool.run`; the reply is narrowed by `type`. */
  run<T extends WorkRequest['type']>(
    request: RequestOfType<T>,
    priority?: LayoutPriority,
  ): Promise<ResponseFor<RequestOfType<T>>>
}

/**
 * How many workers a thumbnail fleet gets.
 *
 * One core is left for the main thread, and the fleet is capped at four.
 * The cap once rested on a claim that fetching a document's bytes, not the
 * render queue, is what a list waits on; that claim is false (a fetch is a
 * near-constant 4-6ms against a render of 9-29ms that grows with the
 * document), so the cap was re-measured on what a list actually does. Forty
 * rows — twenty 20-section markdown bodies and twenty 40-node canvases — at
 * `background` priority, two runs, real browser, four cores:
 *
 *   size 1  warm 284-304ms   cold 2.4-2.9s
 *   size 2  warm 253-263ms   cold 1.3-1.8s
 *   size 3  warm 160-167ms   cold 1.2-2.1s
 *   size 4  warm 137-141ms   cold 1.9-2.0s
 *   size 6  warm 127-165ms   cold 2.0-2.3s
 *
 * Three things the numbers say. A list is RENDER-bound, so fill time tracks
 * the slots it may use — and `background` gets `deferrableSlotCap(size)` of
 * them: `size - 1`, except that a fleet of one keeps its single slot rather
 * than none. That exception is why sizes 1 and 2 are the same speed — one
 * slot each, by two different rules. Past the core count
 * the curve is flat inside its own noise, so on a four-core machine nothing
 * above 4 is measurable HERE; whether an eight-core machine would use a
 * fifth worker is unmeasured, and this cap is what leaves that question
 * open rather than answering it. And the cold pass is 1-3s whatever the
 * size — that is worker startup (module graph, WASM, font registration) paid
 * once per list, not a cap effect, so a smaller fleet does not buy a faster
 * first list.
 *
 * `navigator.hardwareConcurrency` is absent on some browsers; 2 is the
 * conservative answer there, not a guess at the machine.
 */
export function defaultPoolSize(hardwareConcurrency: number | undefined): number {
  if (hardwareConcurrency === undefined || !Number.isFinite(hardwareConcurrency)) return 2
  return Math.max(1, Math.min(4, Math.floor(hardwareConcurrency) - 1))
}

interface Pending<Req> {
  readonly id: number
  readonly request: Req
  readonly priority: LayoutPriority
  resolve(reply: { id: number }): void
  reject(error: Error): void
}

interface Slot<Req> {
  readonly worker: PoolWorker
  /** The request this worker is holding, or null when it is free. */
  busyWith: Pending<Req> | null
}

/**
 * How many workers may be busy with work nobody asked for a moment ago.
 *
 * Ordering the queue is not enough on its own: a worker cannot be
 * interrupted mid-message, so lower-priority work holding every slot would
 * still make an interactive request wait out a render nobody was waiting
 * for. Holding one worker back bounds that wait at zero.
 *
 * The budget is over ALL the lower bands together, not one per band. Counted
 * per band, `idle` would be free to take the very slot `background`'s cap is
 * holding for an interactive request — the reservation defeated by the
 * lowest-value work in the app, exactly when it is doing its job. Measured
 * on a two-worker fleet: an idle request arriving between two background
 * ones ran immediately and both background requests then waited.
 *
 * A single-worker fleet has nothing to hold back. The lower bands run there
 * anyway rather than starving, and an interactive request waits out at most
 * ONE render instead of the whole list — the honest trade on a machine with
 * no cores to spare.
 */
function deferrableSlotCap(size: number): number {
  return size > 1 ? size - 1 : 1
}

/**
 * And `idle` gets one worker whatever the fleet size, inside that budget. A
 * band that could fill every slot it is allowed is not the lowest band
 * however it is labelled — a list of thumbnails would wait out renders
 * nobody is looking at.
 */
const IDLE_SLOT_CAP = 1

export function createLayoutWorkerPool<Req extends { id: number }>(options: {
  size: number
  createWorker: () => PoolWorker
}): LayoutWorkerPool<Req> {
  type Entry = Pending<Req>
  type Held = Slot<Req>
  // A non-finite or non-positive size would otherwise mean "spawn forever"
  // or "never dispatch"; both are worse than one worker.
  const size = Number.isFinite(options.size) ? Math.max(1, Math.floor(options.size)) : 1
  const slots: Held[] = []
  const queue: Entry[] = []
  let disposed = false

  const settle = (slot: Held, id: number, data: { id: number }) => {
    const pending = slot.busyWith
    // A reply for something this slot is no longer holding — a cancelled
    // request the worker finished anyway. Dropping it is the whole handling:
    // `cancel` already freed the slot, so it is either idle or busy with a
    // NEWER request, and clearing it here would throw that one's pending
    // entry away and leave its caller waiting forever.
    if (pending === null || pending.id !== id) return
    slot.busyWith = null
    pending.resolve(data)
    pump()
  }

  const spawn = (): Held => {
    const worker = options.createWorker()
    const slot: Held = { worker, busyWith: null }
    worker.onmessage = (event) => settle(slot, event.data.id, event.data)
    if ('onerror' in worker) {
      worker.onerror = () => {
        const pending = slot.busyWith
        slot.busyWith = null
        // A worker whose module failed to load fires this once and then never
        // posts again. Leaving its slot in the pool makes it look available,
        // and everything dispatched to it waits forever — permanently, since
        // the shared pool is a per-tab singleton nothing disposes. Drop it
        // and let spawn() make a replacement on the next dispatch.
        const at = slots.indexOf(slot)
        if (at !== -1) slots.splice(at, 1)
        worker.terminate()
        pending?.reject(new Error('layout worker errored'))
        pump()
      }
    }
    slots.push(slot)
    return slot
  }

  // Workers are created only as concurrency demands one, so a pool nobody
  // uses costs nothing and a list of two rows never starts four workers.
  const freeSlot = (): Held | undefined =>
    slots.find((slot) => slot.busyWith === null) ?? (slots.length < size ? spawn() : undefined)

  const inFlightAt = (priority: LayoutPriority): number =>
    slots.filter((slot) => slot.busyWith?.priority === priority).length

  const deferrableInFlight = (): number =>
    slots.filter((slot) => slot.busyWith !== null && slot.busyWith.priority !== 'interactive')
      .length

  /**
   * The next request that may run right now: by band, highest first, FIFO
   * within a band, and each band only while it is under its slot cap.
   * Returning an INDEX rather than shifting lets a blocked request stay
   * queued while a higher-priority one goes ahead of it.
   *
   * A band that is queued but AT its cap STOPS the walk rather than letting
   * the next band down take the slot. That slot is the one being held for
   * the band above, so handing it to a lower one defeats the reservation
   * exactly when it is doing its job.
   */
  const nextRunnableIndex = (): number => {
    for (const priority of PRIORITY_ORDER) {
      const at = queue.findIndex((pending) => pending.priority === priority)
      if (at === -1) continue
      if (priority === 'interactive') return at
      if (deferrableInFlight() >= deferrableSlotCap(size)) return -1
      if (priority === 'idle' && inFlightAt('idle') >= IDLE_SLOT_CAP) return -1
      return at
    }
    return -1
  }

  function pump(): void {
    if (disposed) return
    while (queue.length > 0) {
      const index = nextRunnableIndex()
      if (index === -1) return
      const slot = freeSlot()
      if (slot === undefined) return
      const [next] = queue.splice(index, 1)
      if (next === undefined) return
      slot.busyWith = next
      slot.worker.postMessage(next.request)
    }
  }

  return {
    run(request: Req, priority: LayoutPriority = 'interactive'): Promise<{ id: number }> {
      if (disposed) return Promise.reject(new Error('layout worker pool is disposed'))
      return new Promise<{ id: number }>((resolve, reject) => {
        queue.push({
          id: request.id,
          request,
          priority,
          resolve,
          reject,
        })
        pump()
      })
    },

    cancel(id: number): void {
      const queuedAt = queue.findIndex((pending) => pending.id === id)
      if (queuedAt !== -1) {
        const [pending] = queue.splice(queuedAt, 1)
        pending?.reject(new Error(`layout request ${id} cancelled`))
        return
      }
      const slot = slots.find((candidate) => candidate.busyWith?.id === id)
      if (slot?.busyWith) {
        const pending = slot.busyWith
        // The worker keeps running the cancelled request: terminating it to
        // reclaim the slot sooner would throw away a warm font registration,
        // which is the expensive part of starting one. Its late reply is
        // dropped by settle()'s identity check.
        pending.reject(new Error(`layout request ${id} cancelled`))
        slot.busyWith = null
        // Freeing a slot means the queue may have work for it — and every
        // other path that frees one pumps. The stale reply cannot do it
        // later either: settle() takes its already-freed early return, which
        // deliberately does nothing. Without this, queued work waits for an
        // unrelated caller to happen along.
        pump()
      }
    },

    dispose(): void {
      disposed = true
      for (const slot of slots) {
        slot.busyWith?.reject(new Error('layout worker pool is disposed'))
        slot.busyWith = null
        slot.worker.terminate()
      }
      for (const pending of queue.splice(0)) {
        pending.reject(new Error('layout worker pool is disposed'))
      }
    },
  }
}

/**
 * The process-wide fleet. One per tab, created on first use, never disposed:
 * a rail, a favicon and a list all want it, and tearing it down when one of
 * them unmounts would make the next one pay the font registration again.
 */
let shared: ProtocolLayoutWorkerPool | null = null

/**
 * The one place a reply is trusted to match its request's type: the core
 * only echoes what the worker posted, and `layout-worker.ts`'s dispatch is
 * what answers each request type with its own response.
 */
function bindToProtocol(core: LayoutWorkerPool<WorkRequest>): ProtocolLayoutWorkerPool {
  return {
    run: <T extends WorkRequest['type']>(request: RequestOfType<T>, priority?: LayoutPriority) =>
      core.run(request, priority) as Promise<ResponseFor<RequestOfType<T>>>,
    cancel: (id) => core.cancel(id),
    dispose: () => core.dispose(),
  }
}

export function sharedLayoutWorkerPool(): ProtocolLayoutWorkerPool {
  shared ??= bindToProtocol(createSharedFleet())
  return shared
}

function createSharedFleet(): LayoutWorkerPool<WorkRequest> {
  return createLayoutWorkerPool<WorkRequest>({
    size: defaultPoolSize(
      typeof navigator === 'undefined' ? undefined : navigator.hardwareConcurrency,
    ),
    createWorker: () => {
      const worker = new Worker(new URL('./layout-worker.ts', import.meta.url), { type: 'module' })
      // An adapter rather than a cast. `Worker.onmessage` is declared with a
      // `this` type and a full MessageEvent, so no narrower signature can
      // receive it — and the pool only ever reads `data`. Forwarding keeps
      // the pool's interface describing what it actually needs, which is
      // also what lets a test supply a plain object.
      // Every worker this pool starts holds the theme faces the main
      // thread holds, from its first message on, so a thumbnail measures
      // a theme's family the way the editor does.
      const detachFaces = attachThemeFaces(worker)
      const adapter: PoolWorker = {
        postMessage: (request) => worker.postMessage(request),
        terminate: () => {
          detachFaces()
          worker.terminate()
        },
        onmessage: null,
        onerror: null,
      }
      worker.onmessage = (event) => adapter.onmessage?.({ data: event.data })
      worker.onerror = (event) => adapter.onerror?.(event)
      return adapter
    },
  })
}

let nextRequestId = 1

/** Ids are per-tab and monotonic, so a late reply can never match a live request. */
export function nextLayoutRequestId(): number {
  nextRequestId += 1
  return nextRequestId
}
