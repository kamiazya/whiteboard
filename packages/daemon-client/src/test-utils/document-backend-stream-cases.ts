/**
 * The `DocumentBackend` contract's cases about the stream itself: a refused
 * stream open, what the keeper wrote while it was down, a write landing
 * between a read and the routing, and a stream that never carries the
 * document. Composed by `documentBackendContract`, in that order.
 */
import { expect, it, vi } from 'vitest'
import {
  BOUNDED_OPEN_TIMEOUT_MS,
  CASE_TIMEOUT_MS,
  called,
  caughtUpBy,
  DELIVERY_TIMEOUT_MS,
  type DocumentBackendHarness,
  recorder,
} from './document-backend-harness.js'

export function streamCases(
  create: () => DocumentBackendHarness | Promise<DocumentBackendHarness>,
): void {
  streamRefusalCases(create)
  catchUpCases(create)
  routingGapCases(create)
  unroutedCases(create)
}

/** What a caller is told when the keeper refuses the stream open itself. */
function streamRefusalCases(
  create: () => DocumentBackendHarness | Promise<DocumentBackendHarness>,
): void {
  it('reports a refused stream to a backend opened later, and asks again once every backend is released', {
    timeout: CASE_TIMEOUT_MS,
  }, async () => {
    // A transport can outlive every page that heard its refusal — the
    // SharedWorker keeps one per origin — so a page opened later that hears
    // nothing reads "offline" instead of "sign in again", and pages opened
    // after every one of them was released and the credential renewed must
    // not inherit the halt.
    const h = await create()
    if (!h.refuseStream || !h.dropTransport || !h.anotherBackend) {
      h.cleanup()
      return
    }
    const first = recorder()
    h.backend.connect(first.handlers)
    await called(first, 'connected')
    const renew = h.refuseStream()
    h.dropTransport()
    await called(first, 'authError')

    const joiner = h.anotherBackend()
    const joined = recorder()
    joiner.connect(joined.handlers)
    await called(joined, 'authError')
    // Told it was the stream, which a page reads as "sign in again" — a
    // refused push would leave it reading as following.
    expect(first.authCauses).toEqual(['stream'])
    expect(joined.authCauses).toEqual(['stream'])

    renew()
    h.backend.disconnect()
    joiner.disconnect()
    const reopened = h.anotherBackend()
    const again = recorder()
    reopened.connect(again.handlers)
    await vi.waitFor(() => expect(again.calls).toContain('connected'), {
      timeout: BOUNDED_OPEN_TIMEOUT_MS,
    })
    reopened.disconnect()
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
