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
import {
  BOUNDED_OPEN_TIMEOUT_MS,
  CASE_TIMEOUT_MS,
  called,
  DELIVERY_TIMEOUT_MS,
  type DocumentBackendHarness,
  type LocalEdit,
  recorder,
} from './document-backend-harness.js'
import { streamCases } from './document-backend-stream-cases.js'

export type { DocumentBackendHarness } from './document-backend-harness.js'

/** The byte-relay form of `localEdit`: arbitrary bytes, landed once sent. */
function sentBytes(h: DocumentBackendHarness): LocalEdit | null {
  const sent = h.sentUpdates
  if (sent === undefined) return null
  const bytes = new Uint8Array([4, 5, 6])
  return { bytes, landed: () => sent().some((b) => b.join() === bytes.join()) }
}

/**
 * A window for a wrong delivery to arrive in, for a case asserting none does.
 * Never a wait for something the case then expects: how long a correct
 * delivery takes is the implementation's and the machine's, and over the
 * SharedWorker a loaded run has measured it past this window.
 */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 100))

export function documentBackendContract(
  create: () => DocumentBackendHarness | Promise<DocumentBackendHarness>,
): void {
  lifecycleCases(create)
  teardownCases(create)
  transportCases(create)
  authCases(create)
  streamCases(create)
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

/**
 * Resolves once a control backend, dropped with a failure that is NOT a
 * refused credential when `drop` is called, has asked the keeper twice more:
 * the reconnect, then the retry its backoff schedules. A backend dropped just
 * before it that kept retrying after a refusal has had the same schedule to
 * make its own retry in, however slow the machine is running.
 */
async function backoffClock(
  create: () => DocumentBackendHarness | Promise<DocumentBackendHarness>,
): Promise<{ drop(): void; retried(): Promise<void>; cleanup(): void } | null> {
  const control = await create()
  const { keeperAsks, failsNextKeeperAsk, dropTransport } = control
  if (!keeperAsks || !failsNextKeeperAsk || !dropTransport) {
    control.cleanup()
    return null
  }
  const rec = recorder()
  control.backend.connect(rec.handlers)
  await called(rec, 'connected')
  let before = keeperAsks()
  return {
    drop: () => {
      before = keeperAsks()
      failsNextKeeperAsk()
      dropTransport()
    },
    retried: () =>
      vi.waitFor(() => expect(keeperAsks()).toBeGreaterThanOrEqual(before + 2), {
        timeout: DELIVERY_TIMEOUT_MS,
      }),
    cleanup: () => {
      control.backend.disconnect()
      control.cleanup()
    },
  }
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
    // A backend that retries a refused credential announces it again only at
    // its next attempt, a backoff later and past any fixed window, so a
    // control's own retry is what says that attempt would have come by now.
    const clock = await backoffClock(create)
    const asksBefore = h.keeperAsks?.()

    h.refuseAuth()
    h.dropTransport()
    clock?.drop()
    // Polled, not settled: the refusal is met on the backend's own reconnect
    // attempt, which sits behind its production backoff.
    await called(rec, 'authError')
    await clock?.retried()
    await settle()

    expect(rec.calls.filter((c) => c === 'authError')).toEqual(['authError'])
    // A request this document's following depends on, never a push.
    expect(['stream', 'subscribe']).toContain(rec.authCauses[0])
    // The refused reconnect, and no attempt after it.
    if (asksBefore !== undefined) expect(h.keeperAsks?.()).toBe(asksBefore + 1)
    clock?.cleanup()
    h.backend.disconnect()
    h.cleanup()
  })
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

    await vi.waitFor(async () => expect(await edit.landed()).toBe(true), {
      timeout: DELIVERY_TIMEOUT_MS,
    })
    h.cleanup()
  })
}
