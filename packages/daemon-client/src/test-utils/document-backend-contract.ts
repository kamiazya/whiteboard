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
  cleanup(): void
}

interface Recorded {
  handlers: DocumentBackendHandlers
  calls: string[]
}

function recorder(): Recorded {
  const calls: string[] = []
  return {
    calls,
    handlers: {
      onSnapshot: () => calls.push('snapshot'),
      onRemoteUpdate: () => calls.push('update'),
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
  it('seeds the document and reports the connection', async () => {
    // Deliberately no ordering assertion between the two. The implementations
    // genuinely disagree — the SSE backend fetches the snapshot before it
    // subscribes, while a store-backed one reports its connection first — and
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

  it('never throws on a control message sent before connecting', async () => {
    // The editor can report readiness while the transport is still coming
    // up, or after it dropped. Every implementation either queues or
    // ignores; none may throw into the caller.
    const h = await create()

    expect(() => h.backend.sendClientReady()).not.toThrow()
    h.cleanup()
  })
}
