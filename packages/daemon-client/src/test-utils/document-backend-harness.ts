/**
 * What a `DocumentBackend` contract case is handed, and the helpers every case
 * family records and waits through — kept apart from the cases so a family can
 * live in its own file and still share one set of ceilings.
 */
import { expect, vi } from 'vitest'
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
   * reconnect `dropTransport` provokes is refused — on the stream, or, where
   * the stream is shared with other backends, on this backend's subscribe,
   * as the daemon refuses a workspace the credential may not enter. Omitted by an
   * implementation with no credential to refuse (the backend over a workspace kept in the
   * browser).
   */
  refuseAuth?(): void
  /**
   * Make the keeper refuse the stream open itself for the credential, until
   * the returned function is called — the credential renewed, as a sign-in
   * does. Unlike `refuseAuth` it refuses the transport every backend on it
   * shares, so a harness whose stream is shared must not keep a claim of its
   * own on it from here on. Omitted, with `anotherBackend`, by an
   * implementation with no stream.
   */
  refuseStream?(): () => void
  /**
   * A further backend on the same keeper and transport, for a document no
   * backend has open — another page opening another document. Each call is a
   * new document, and the case that asks for one disconnects it.
   */
  anotherBackend?(): DocumentBackend
  /**
   * How many times this backend has asked the keeper for its document,
   * refused asks included — so a case can tell a backend that stopped from
   * one still retrying. On a stream of its own an ask is a stream open; on a
   * stream shared with other backends it is the document's subscribe, since
   * there being asked for again IS the reconnect. Omitted, with
   * `failsNextKeeperAsk`, by an implementation with no stream.
   */
  keeperAsks?(): number
  /**
   * Make the keeper fail this backend's next ask with a failure that is not
   * a refused credential (a daemon restarting), and answer the asks after it
   * normally.
   */
  failsNextKeeperAsk?(): void
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

export interface LocalEdit {
  bytes: Uint8Array
  landed(): boolean | Promise<boolean>
}

interface Recorded {
  handlers: DocumentBackendHandlers
  calls: string[]
  /** Every snapshot and update delivered, in order. */
  delivered: Uint8Array[]
  /** The first snapshot delivered, or `null` before one was. */
  snapshot(): Uint8Array | null
}

export function recorder(): Recorded {
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

/** A ceiling on a delivery the case requires, not a delay: it returns as soon as the delivery is there. */
export const DELIVERY_TIMEOUT_MS = 5000

/**
 * The ceiling on a delivery that first waits out one of the backend's own
 * bounds — `UNROUTED_OPEN_MS` before an unrouted open, or a failed open's
 * retry — so it owes that bound on top of the delivery itself.
 */
export const BOUNDED_OPEN_TIMEOUT_MS = 10_000

/** A case's own ceiling, for one that polls several steps behind a production reconnect backoff. */
export const CASE_TIMEOUT_MS = 20_000

export const called = (rec: Recorded, ...calls: string[]): Promise<void> =>
  vi.waitFor(
    () => {
      for (const call of calls) expect(rec.calls).toContain(call)
    },
    { timeout: DELIVERY_TIMEOUT_MS },
  )

/** Until the bytes delivered so far reproduce the keeper's state. */
export const caughtUpBy = (
  rec: Recorded,
  caughtUp: (delivered: readonly Uint8Array[]) => boolean,
): Promise<void> =>
  vi.waitFor(() => expect(caughtUp(rec.delivered)).toBe(true), { timeout: DELIVERY_TIMEOUT_MS })
