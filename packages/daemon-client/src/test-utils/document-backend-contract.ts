/**
 * The behavioural contract every `DocumentBackend` must satisfy, written once and
 * run against each implementation.
 *
 * Two ship — the SSE backend and the one over a workspace kept in the
 * browser — and each grew its own suite, so a behaviour one of them
 * got wrong was only ever caught if someone thought to write that case in that
 * file. The teardown case below is the clearest example: a delivery after
 * `disconnect()` resurrects state the caller deliberately left, and it is a
 * hazard every backend has for its own reasons.
 *
 * What this deliberately does NOT replace: the finer per-implementation races.
 * A snapshot whose *body read* completes after disconnect — one await later
 * than the response — cannot be provoked without controlling that
 * implementation's timing, so it stays pinned where it can be
 * (`sse-backend.test.ts`). A contract is a floor under every implementation,
 * not a substitute for knowing one.
 *
 * Cases here are deliberately implementation-independent — no assertion about
 * which endpoint is called or what the snapshot bytes are, only about what a
 * caller of the port is entitled to rely on.
 */
import { expect, it, vi } from 'vitest'
import type { DocumentBackend, DocumentBackendHandlers } from '../document-backend-contract.js'

export interface DocumentBackendHarness {
  backend: DocumentBackend
  /**
   * Bytes the backend has pushed upstream, however it does that. Omitted by
   * an implementation whose upstream is not a byte relay — the browser
   * backend imports an update into the workspace document and persists the
   * EFFECT, so the input bytes never travel anywhere to be observed. The
   * send case below then skips (like `dropTransport`), and that
   * implementation owes its own suite an equivalent effect-based case.
   */
  sentUpdates?(): Uint8Array[]
  /**
   * Drop this backend's transport, if it has one. Omitted by an
   * implementation with nothing to drop (the backend over a workspace kept in
   * the browser reads a store, so it is never disconnected) — the case below then skips rather
   * than asserting a behaviour that cannot exist.
   */
  dropTransport?(): void
  /**
   * Make the keeper refuse this backend's credential from now on, so the
   * reconnect `dropTransport` provokes is answered 401. Omitted by an
   * implementation with no credential to refuse (the backend over a workspace kept in the
   * browser).
   */
  refuseAuth?(): void
  /**
   * An update a caller of this port would push, built against the snapshot
   * the backend delivered, and how to tell the keeper took it. For an
   * implementation whose upstream is not a byte relay; one with
   * `sentUpdates` needs none, since the bytes it sent are the evidence.
   */
  localEdit?(snapshot: Uint8Array | null): LocalEdit
  /**
   * The keeper changing the document on its own — an agent's tool call,
   * another device. `live` says whether this backend's transport is up to
   * carry the change as a frame; without it the change reaches only the
   * keeper's own store. Omitted, with `caughtUp`, by an implementation with
   * no transport to miss a frame on.
   */
  keeperWrites?(live: boolean): void
  /**
   * Arm the keeper to commit a write of its own the moment it has served its
   * next snapshot — an agent's tool call landing while a page is still
   * opening. Like any write it is broadcast only to the streams the daemon
   * routes this document into at that moment. Omitted, with `caughtUp`, by an
   * implementation with no stream to be routed.
   */
  keeperWritesAfterNextSnapshot?(): void
  /**
   * Make the keeper's stream never carry this backend's workspace, while its
   * snapshot route keeps answering: `refused` answers the subscribe for it
   * with a refusal (a balancer that sent it to a daemon that does not know
   * the stream), `silent` leaves it unrouted with nothing said (a buffering
   * proxy holding the stream back). Called before `connect`. Omitted by an
   * implementation with no stream to route.
   */
  neverRoutes?(how: 'refused' | 'silent'): void
  /**
   * Make the keeper fail the read this backend's open makes of the document
   * — a daemon restarting, a proxy's passing 5xx — while everything else
   * answers, and answer the reads after it. Called before `connect`. Omitted
   * by an implementation whose state is not read from a keeper that can be
   * away.
   */
  failsOpeningRead?(): void
  /**
   * Make the keeper refuse the next write this backend sends, for what its
   * bytes would do; when `thenItsReadFails`, the read of the keeper's state
   * that the refusal sends the backend to make fails as well. Omitted by an
   * implementation whose keeper cannot refuse bytes, or whose refusal reaches
   * the caller only once that read has already succeeded (the SharedWorker
   * announces one after rebuilding its replica from the daemon).
   */
  refusesNextWrite?(thenItsReadFails: boolean): void
  /**
   * How many of the keeper's reads have been answered with a failure so far,
   * so a case can tell when a failing read has actually reached the backend
   * rather than guessing at how long that takes. Omitted with
   * `refusesNextWrite`.
   */
  failedReads?(): number
  /**
   * Whether the bytes this backend delivered — the snapshot and every
   * update, in delivery order — reproduce the keeper's current state when
   * applied. False for a frame left waiting on history it builds on.
   */
  caughtUp?(delivered: readonly Uint8Array[]): boolean
  cleanup(): void
}

interface LocalEdit {
  bytes: Uint8Array
  landed(): boolean | Promise<boolean>
}

/** The byte-relay form of `localEdit`: arbitrary bytes, landed once sent. */
function sentBytes(h: DocumentBackendHarness): LocalEdit | null {
  const sent = h.sentUpdates
  if (sent === undefined) return null
  const bytes = new Uint8Array([4, 5, 6])
  return { bytes, landed: () => sent().some((b) => b.join() === bytes.join()) }
}

interface Recorded {
  handlers: DocumentBackendHandlers
  calls: string[]
  /** Every snapshot and update delivered, in order. */
  delivered: Uint8Array[]
  /** The first snapshot delivered, or `null` before one was. */
  snapshot(): Uint8Array | null
}

function recorder(): Recorded {
  const calls: string[] = []
  const delivered: Uint8Array[] = []
  let snapshot: Uint8Array | null = null
  return {
    calls,
    delivered,
    snapshot: () => snapshot,
    handlers: {
      onSnapshot: (bytes) => {
        snapshot ??= bytes
        delivered.push(bytes)
        calls.push('snapshot')
      },
      onRemoteUpdate: (bytes) => {
        delivered.push(bytes)
        calls.push('update')
      },
      onConnected: () => calls.push('connected'),
      onDisconnected: () => calls.push('disconnected'),
      onVersionCreated: () => calls.push('version'),
      onRestoreStarted: () => calls.push('restoreStarted'),
      onRestoreComplete: () => calls.push('restoreComplete'),
      onViewportRequest: () => calls.push('viewport'),
      onAuthError: () => calls.push('authError'),
      onWriteRefused: () => calls.push('writeRefused'),
    } satisfies DocumentBackendHandlers,
  }
}

/**
 * A window for a wrong delivery to arrive in, for a case asserting none does.
 * Never a wait for something the case then expects: how long a correct
 * delivery takes is the implementation's and the machine's, and over the
 * SharedWorker a loaded run has measured it past this window.
 */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 100))

/** A ceiling on a delivery the case requires, not a delay: it returns as soon as the delivery is there. */
const DELIVERY_TIMEOUT_MS = 5000

/**
 * The ceiling on a delivery that first waits out one of the backend's own
 * bounds — `UNROUTED_OPEN_MS` before an unrouted open, or a failed open's
 * retry — so it owes that bound on top of the delivery itself.
 */
const BOUNDED_OPEN_TIMEOUT_MS = 10_000

/** A case's own ceiling, for one that polls several steps behind a production reconnect backoff. */
const CASE_TIMEOUT_MS = 20_000

const called = (rec: Recorded, ...calls: string[]): Promise<void> =>
  vi.waitFor(
    () => {
      for (const call of calls) expect(rec.calls).toContain(call)
    },
    { timeout: DELIVERY_TIMEOUT_MS },
  )

/** Until the bytes delivered so far reproduce the keeper's state. */
const caughtUpBy = (
  rec: Recorded,
  caughtUp: (delivered: readonly Uint8Array[]) => boolean,
): Promise<void> =>
  vi.waitFor(() => expect(caughtUp(rec.delivered)).toBe(true), { timeout: DELIVERY_TIMEOUT_MS })

export function documentBackendContract(
  create: () => DocumentBackendHarness | Promise<DocumentBackendHarness>,
): void {
  lifecycleCases(create)
  teardownCases(create)
  transportCases(create)
  authCases(create)
  catchUpCases(create)
  routingGapCases(create)
  unroutedCases(create)
  failedOpenCases(create)
  failedResyncCases(create)
  upstreamDeliveryCases(create)

  it('never throws on a control message sent before connecting', async () => {
    // The editor can report readiness while the transport is still coming
    // up, or after it dropped. Every implementation either queues or
    // ignores; none may throw into the caller.
    const h = await create()

    expect(() => h.backend.sendClientReady()).not.toThrow()
    h.cleanup()
  })
}

/** Connecting. */
function lifecycleCases(
  create: () => DocumentBackendHarness | Promise<DocumentBackendHarness>,
): void {
  it('seeds the document and reports the connection', async () => {
    // Deliberately no ordering assertion between the two. The implementations
    // genuinely disagree — the SSE backend reports its connection after the
    // snapshot it reads once routed, while a store-backed one reports its
    // connection first — and
    // the port has never specified which. Pinning one here would silently make the other's behaviour a bug.
    const h = await create()
    const rec = recorder()

    h.backend.connect(rec.handlers)

    await called(rec, 'snapshot', 'connected')
    h.backend.disconnect()
    h.cleanup()
  })
}

/** Tearing down mid-connect. */
function teardownCases(
  create: () => DocumentBackendHarness | Promise<DocumentBackendHarness>,
): void {
  it('delivers nothing more once disconnect has returned', async () => {
    // Connecting does asynchronous work in every implementation, so a teardown
    // can always land mid-flight. Seeding a document the caller has abandoned
    // resurrects state it deliberately left behind.
    //
    // Measured from the moment disconnect returns, not from connect: a
    // callback the backend fires synchronously inside connect() has already
    // been delivered to a caller that was still listening, and forbidding that
    // would make a legitimate design (the backend over a workspace kept in the
    // browser reports its connection immediately) fail for no reason.
    //
    // A control connection, opened alongside and left up, is what makes the
    // absence mean something: its own seeding has landed, so the abandoned
    // connect's identical work had the same time to deliver, however slow
    // the machine is running.
    const h = await create()
    const control = await create()
    const rec = recorder()
    const controlRec = recorder()

    h.backend.connect(rec.handlers)
    control.backend.connect(controlRec.handlers)
    h.backend.disconnect()
    const atDisconnect = [...rec.calls]
    await called(controlRec, 'snapshot', 'connected')

    expect(rec.calls).toEqual(atDisconnect)
    control.backend.disconnect()
    control.cleanup()
    h.cleanup()
  })
}

/** What a caller is told when its backend's transport drops. */
function transportCases(
  create: () => DocumentBackendHarness | Promise<DocumentBackendHarness>,
): void {
  it('reports a disconnect when its transport drops', async () => {
    // Without it the caller cannot tell a quiet connection from a dead one,
    // and the UI keeps reporting sync that is not happening.
    const h = await create()
    if (!h.dropTransport) {
      h.cleanup()
      return
    }
    const rec = recorder()
    h.backend.connect(rec.handlers)
    await called(rec, 'connected')
    const before = rec.calls.length

    h.dropTransport()

    // Counted from the drop: a backend may report itself disconnected before
    // it first connects, which says nothing about noticing this drop.
    await vi.waitFor(() => expect(rec.calls.slice(before)).toContain('disconnected'), {
      timeout: DELIVERY_TIMEOUT_MS,
    })
    h.backend.disconnect()
    h.cleanup()
  })
}

/** What a caller is told when the keeper refuses its credential. */
function authCases(create: () => DocumentBackendHarness | Promise<DocumentBackendHarness>): void {
  it('reports a refused credential as an auth error, not as a disconnect', async () => {
    // The page's "Sync off" state hangs off this callback alone. A backend
    // that answers a 401 with `onDisconnected` and keeps retrying leaves the
    // chip reading "reconnecting" until the tab closes.
    const h = await create()
    if (!h.dropTransport || !h.refuseAuth) {
      h.cleanup()
      return
    }
    const rec = recorder()
    h.backend.connect(rec.handlers)
    await called(rec, 'connected')

    h.refuseAuth()
    h.dropTransport()
    // Polled, not settled: the refusal is met on the backend's own reconnect
    // attempt, which sits behind its production backoff.
    await vi.waitFor(() => expect(rec.calls).toContain('authError'), {
      timeout: DELIVERY_TIMEOUT_MS,
    })
    await settle()

    expect(rec.calls.filter((c) => c === 'authError')).toEqual(['authError'])
    h.backend.disconnect()
    h.cleanup()
  })
}

/** What the keeper wrote while the caller's stream was down. */
function catchUpCases(
  create: () => DocumentBackendHarness | Promise<DocumentBackendHarness>,
): void {
  // Three polled steps behind a production reconnect backoff.
  it('delivers what the keeper wrote while the stream was down, after it reconnects', {
    timeout: CASE_TIMEOUT_MS,
  }, async () => {
    // A stream carries only what is written while it is open, so the keeper's
    // writes during the gap reach no frame. Unless the backend asks for them
    // on reconnect, they never arrive — and every later frame builds on them,
    // so a CRDT holds each one back waiting for history it will never get,
    // while the page reads connected.
    const h = await create()
    if (!h.dropTransport || !h.keeperWrites || !h.caughtUp) {
      h.cleanup()
      return
    }
    const { keeperWrites, caughtUp } = h
    const rec = recorder()
    h.backend.connect(rec.handlers)
    await called(rec, 'connected')

    h.dropTransport()
    keeperWrites(false)
    await vi.waitFor(
      () => expect(rec.calls.filter((c) => c === 'connected').length).toBeGreaterThan(1),
      { timeout: DELIVERY_TIMEOUT_MS },
    )
    await caughtUpBy(rec, caughtUp)

    // And the next live frame applies, rather than waiting on the gap.
    keeperWrites(true)
    await caughtUpBy(rec, caughtUp)
    // Merged, never replacing: a caller rebuilds its document from a
    // snapshot, which would cost the page its undo history and remount the
    // editor at every reconnect.
    expect(rec.calls.filter((c) => c === 'snapshot')).toEqual(['snapshot'])
    h.backend.disconnect()
    h.cleanup()
  })
}

/**
 * What the keeper wrote between serving the state a caller starts from and
 * routing the caller's stream. The stream replays nothing, so state read
 * before the daemon routes the document leaves a write in between in no
 * frame, and a CRDT holds every later frame back for it while the page reads
 * connected — at every open, and again at every reconnect.
 */
function routingGapCases(
  create: () => DocumentBackendHarness | Promise<DocumentBackendHarness>,
): void {
  it('delivers a keeper write committed after the snapshot but before the subscription', {
    timeout: CASE_TIMEOUT_MS,
  }, async () => {
    const h = await create()
    if (!h.keeperWritesAfterNextSnapshot || !h.keeperWrites || !h.caughtUp) {
      h.cleanup()
      return
    }
    const { keeperWrites, caughtUp } = h
    h.keeperWritesAfterNextSnapshot()
    const rec = recorder()
    h.backend.connect(rec.handlers)
    await called(rec, 'connected')

    keeperWrites(true)
    await caughtUpBy(rec, caughtUp)
    h.backend.disconnect()
    h.cleanup()
  })

  // Polled steps behind a production reconnect backoff.
  it('delivers a keeper write committed after the catch-up snapshot but before the re-subscription', {
    timeout: CASE_TIMEOUT_MS,
  }, async () => {
    const h = await create()
    if (!h.dropTransport || !h.keeperWritesAfterNextSnapshot || !h.keeperWrites || !h.caughtUp) {
      h.cleanup()
      return
    }
    const { keeperWrites, caughtUp } = h
    const rec = recorder()
    h.backend.connect(rec.handlers)
    await called(rec, 'connected')

    h.keeperWritesAfterNextSnapshot()
    h.dropTransport()
    await vi.waitFor(
      () => expect(rec.calls.filter((c) => c === 'connected').length).toBeGreaterThan(1),
      { timeout: DELIVERY_TIMEOUT_MS },
    )
    keeperWrites(true)
    await caughtUpBy(rec, caughtUp)
    h.backend.disconnect()
    h.cleanup()
  })
}

/**
 * A stream that never carries the document. Reading state only once it does
 * is what keeps a write from falling between the read and the routing — but a
 * stream that is refused, or held back by something between the page and
 * the keeper, would then leave the caller with no document at all while the
 * keeper's snapshot route answers. The caller must still be handed the
 * keeper's state.
 */
function unroutedCases(
  create: () => DocumentBackendHarness | Promise<DocumentBackendHarness>,
): void {
  for (const how of ['refused', 'silent'] as const) {
    // Polled: the silent case waits out the backend's own bound on routing.
    it(`a document whose stream is ${how === 'refused' ? 'refused' : 'never routed'} still receives the keeper's state`, {
      timeout: CASE_TIMEOUT_MS,
    }, async () => {
      const h = await create()
      if (!h.neverRoutes || !h.caughtUp) {
        h.cleanup()
        return
      }
      const { caughtUp } = h
      h.neverRoutes(how)
      const rec = recorder()
      h.backend.connect(rec.handlers)

      await vi.waitFor(() => expect(rec.calls).toContain('snapshot'), {
        timeout: BOUNDED_OPEN_TIMEOUT_MS,
      })
      expect(caughtUp(rec.delivered)).toBe(true)
      // Not live, and not claimed to be: nothing carries the keeper's writes.
      expect(rec.calls).not.toContain('connected')
      h.backend.disconnect()
      h.cleanup()
    })
  }
}

/**
 * An opening read that fails. The caller has no copy yet, so nothing the
 * backend MERGES can reach it: the keeper's state has to arrive as the
 * snapshot it starts from, and the connection must not be claimed over
 * nothing — a page told it is connected while it holds no document stays on
 * its loading state for good.
 */
function failedOpenCases(
  create: () => DocumentBackendHarness | Promise<DocumentBackendHarness>,
): void {
  for (const dropped of [false, true]) {
    // Polled: the retry waits out the backend's own bound, and a drop its reconnect backoff.
    it(`a document whose opening read fails${dropped ? ', then drops,' : ''} still receives the keeper's state through onSnapshot, not after connected`, {
      timeout: CASE_TIMEOUT_MS,
    }, async () => {
      const h = await create()
      if (!h.failsOpeningRead || !h.caughtUp) {
        h.cleanup()
        return
      }
      const { caughtUp } = h
      h.failsOpeningRead()
      const rec = recorder()
      h.backend.connect(rec.handlers)
      if (dropped) {
        await settle()
        h.dropTransport?.()
      }

      await vi.waitFor(() => expect(rec.calls).toContain('snapshot'), {
        timeout: BOUNDED_OPEN_TIMEOUT_MS,
      })
      expect(rec.calls.slice(0, rec.calls.indexOf('snapshot'))).not.toContain('connected')
      const snapshot = rec.snapshot()
      expect(snapshot !== null && caughtUp([snapshot])).toBe(true)
      await vi.waitFor(() => expect(rec.calls).toContain('connected'), {
        timeout: BOUNDED_OPEN_TIMEOUT_MS,
      })
      h.backend.disconnect()
      h.cleanup()
    })
  }
}

/**
 * Resolves once the keeper has answered one more read with a failure than it
 * had when this was called — so a window after it covers what the backend
 * does with that answer on a machine of any speed. Required of a harness
 * that refuses writes: without it the window is a fixed guess at how long the
 * failing read takes to arrive.
 */
function failedReadCounter(h: DocumentBackendHarness): () => Promise<void> {
  const failedReads = h.failedReads
  if (failedReads === undefined) throw new Error('a harness that refuses writes owes failedReads')
  const before = failedReads()
  return async () => {
    await vi.waitFor(() => expect(failedReads()).toBe(before + 1), {
      timeout: DELIVERY_TIMEOUT_MS,
    })
  }
}

/**
 * A refused write sends the caller to the keeper's state, and that read can
 * fail like any other. The caller's copy is all it has then: replacing it
 * with nothing, or counting the failure as a replacement that happened, loses
 * the copy or the next read that would have replaced it.
 */
function failedResyncCases(
  create: () => DocumentBackendHarness | Promise<DocumentBackendHarness>,
): void {
  // Polled: the refusal reaches the caller through the backend's write queue.
  it('a resync answered with a failed read leaves the caller copy and onSnapshot untouched', {
    timeout: CASE_TIMEOUT_MS,
  }, async () => {
    const h = await create()
    const refusesNextWrite = h.refusesNextWrite
    if (!refusesNextWrite) {
      h.cleanup()
      return
    }
    const rec = recorder()
    h.backend.connect(rec.handlers)
    await called(rec, 'connected')
    const push = (): void => {
      const edit = h.localEdit?.(rec.snapshot()) ?? sentBytes(h)
      if (edit === null) throw new Error('a harness that refuses writes owes a way to make one')
      void Promise.resolve(h.backend.pushLocalUpdate(edit.bytes)).catch(() => {})
    }
    const refusals = () => rec.calls.filter((c) => c === 'writeRefused').length
    const before = [...rec.delivered]
    const failedReadAnswered = failedReadCounter(h)

    refusesNextWrite(true)
    push()
    await vi.waitFor(() => expect(refusals()).toBe(1), { timeout: DELIVERY_TIMEOUT_MS })
    await failedReadAnswered()
    await settle()
    expect(rec.delivered).toEqual(before)

    // Nothing was spent on the failure: the next refusal's read still replaces.
    refusesNextWrite(false)
    push()
    await vi.waitFor(() => expect(refusals()).toBe(2), { timeout: DELIVERY_TIMEOUT_MS })
    await vi.waitFor(
      () => expect(rec.calls.filter((c) => c === 'snapshot')).toEqual(['snapshot', 'snapshot']),
      { timeout: DELIVERY_TIMEOUT_MS },
    )
    // Asked again at the end, so a delivery the failure caused later than the
    // window above is caught too: the replacing snapshot is the only one since.
    expect(rec.delivered.slice(0, before.length)).toEqual(before)
    expect(rec.delivered).toHaveLength(before.length + 1)
    h.backend.disconnect()
    h.cleanup()
  })
}

/** What reaches the keeper of what a caller pushed — while connected, and across teardown. */
function upstreamDeliveryCases(
  create: () => DocumentBackendHarness | Promise<DocumentBackendHarness>,
): void {
  it('sends a local update upstream', async () => {
    const h = await create()
    if (!h.sentUpdates) {
      h.cleanup()
      return
    }
    const sentUpdates = h.sentUpdates
    const rec = recorder()
    h.backend.connect(rec.handlers)
    await called(rec, 'connected')

    await h.backend.pushLocalUpdate(new Uint8Array([4, 5, 6]))

    await vi.waitFor(() => expect(sentUpdates()).toContainEqual(new Uint8Array([4, 5, 6])), {
      timeout: DELIVERY_TIMEOUT_MS,
    })
    h.backend.disconnect()
    h.cleanup()
  })

  it('still delivers an update it accepted before disconnect', async () => {
    // Teardown follows the last edit closely — a document switch disposes
    // the session the moment the edit is handed over — so a backend that
    // dropped what it had already accepted would lose exactly that edit,
    // with no page left to say it was not saved.
    const h = await create()
    const rec = recorder()
    h.backend.connect(rec.handlers)
    // The edit is built against the delivered snapshot, as a caller's is.
    await called(rec, 'snapshot', 'connected')
    const edit = h.localEdit?.(rec.snapshot()) ?? sentBytes(h)
    if (edit === null) {
      h.backend.disconnect()
      h.cleanup()
      return
    }

    void Promise.resolve(h.backend.pushLocalUpdate(edit.bytes)).catch(() => {})
    h.backend.disconnect()

    await vi.waitFor(async () => expect(await edit.landed()).toBe(true))
    h.cleanup()
  })
}
