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
    } satisfies DocumentBackendHandlers,
  }
}

/** Long enough for any in-flight async connect work to land if it is going to. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 100))

export function documentBackendContract(
  create: () => DocumentBackendHarness | Promise<DocumentBackendHarness>,
): void {
  lifecycleCases(create)
  transportCases(create)
  catchUpCases(create)
  routingGapCases(create)
  unroutedCases(create)
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

/** Connecting, and tearing down mid-connect. */
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
    await settle()

    expect(rec.calls).toContain('snapshot')
    expect(rec.calls).toContain('connected')
    h.backend.disconnect()
    h.cleanup()
  })

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
    const h = await create()
    const rec = recorder()

    h.backend.connect(rec.handlers)
    h.backend.disconnect()
    const atDisconnect = [...rec.calls]
    await settle()

    expect(rec.calls).toEqual(atDisconnect)
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
    await settle()
    expect(rec.calls).toContain('connected')

    h.dropTransport()
    await settle()

    expect(rec.calls).toContain('disconnected')
    h.backend.disconnect()
    h.cleanup()
  })

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
    await settle()
    expect(rec.calls).toContain('connected')

    h.refuseAuth()
    h.dropTransport()
    // Polled, not settled: the refusal is met on the backend's own reconnect
    // attempt, which sits behind its production backoff.
    await vi.waitFor(() => expect(rec.calls).toContain('authError'), { timeout: 5000 })
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
    timeout: 20_000,
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
    await vi.waitFor(() => expect(rec.calls).toContain('connected'), { timeout: 5000 })

    h.dropTransport()
    keeperWrites(false)
    await vi.waitFor(
      () => expect(rec.calls.filter((c) => c === 'connected').length).toBeGreaterThan(1),
      { timeout: 5000 },
    )
    await vi.waitFor(() => expect(caughtUp(rec.delivered)).toBe(true), { timeout: 5000 })

    // And the next live frame applies, rather than waiting on the gap.
    keeperWrites(true)
    await vi.waitFor(() => expect(caughtUp(rec.delivered)).toBe(true), { timeout: 5000 })
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
    timeout: 20_000,
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
    await vi.waitFor(() => expect(rec.calls).toContain('connected'), { timeout: 5000 })

    keeperWrites(true)
    await vi.waitFor(() => expect(caughtUp(rec.delivered)).toBe(true), { timeout: 5000 })
    h.backend.disconnect()
    h.cleanup()
  })

  // Polled steps behind a production reconnect backoff.
  it('delivers a keeper write committed after the catch-up snapshot but before the re-subscription', {
    timeout: 20_000,
  }, async () => {
    const h = await create()
    if (!h.dropTransport || !h.keeperWritesAfterNextSnapshot || !h.keeperWrites || !h.caughtUp) {
      h.cleanup()
      return
    }
    const { keeperWrites, caughtUp } = h
    const rec = recorder()
    h.backend.connect(rec.handlers)
    await vi.waitFor(() => expect(rec.calls).toContain('connected'), { timeout: 5000 })

    h.keeperWritesAfterNextSnapshot()
    h.dropTransport()
    await vi.waitFor(
      () => expect(rec.calls.filter((c) => c === 'connected').length).toBeGreaterThan(1),
      { timeout: 5000 },
    )
    keeperWrites(true)
    await vi.waitFor(() => expect(caughtUp(rec.delivered)).toBe(true), { timeout: 5000 })
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
      timeout: 20_000,
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

      await vi.waitFor(() => expect(rec.calls).toContain('snapshot'), { timeout: 10_000 })
      expect(caughtUp(rec.delivered)).toBe(true)
      // Not live, and not claimed to be: nothing carries the keeper's writes.
      expect(rec.calls).not.toContain('connected')
      h.backend.disconnect()
      h.cleanup()
    })
  }
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
    const rec = recorder()
    h.backend.connect(rec.handlers)
    await settle()

    await h.backend.pushLocalUpdate(new Uint8Array([4, 5, 6]))
    await settle()

    expect(h.sentUpdates()).toContainEqual(new Uint8Array([4, 5, 6]))
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
    await settle()
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
