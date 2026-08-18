/**
 * The behavioural contract every `DocumentBackend` must satisfy, written once and
 * run against each implementation.
 *
 * Three ship — the WebSocket daemon backend, the SSE backend, and the
 * browser-local one — and each grew its own suite, so a behaviour one of them
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
import { expect, it } from 'vitest'
import type { DocumentBackend, DocumentBackendHandlers } from '../document-backend-contract.js'

export interface DocumentBackendHarness {
  backend: DocumentBackend
  /** Bytes the backend has pushed upstream, however it does that. */
  sentUpdates(): Uint8Array[]
  /**
   * Drop this backend's transport, if it has one. Omitted by an
   * implementation with nothing to drop (the browser-local backend reads a
   * store, so it is never disconnected) — the case below then skips rather
   * than asserting a behaviour that cannot exist.
   */
  dropTransport?(): void
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
      onHeadChanged: () => calls.push('head'),
      onViewportRequest: () => calls.push('viewport'),
      onExportRequest: () => calls.push('export'),
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
    // genuinely disagree — a WebSocket is "connected" when the socket opens and
    // the snapshot is the first frame after, while the SSE backend fetches the
    // snapshot before it subscribes — and the port has never specified which.
    // Pinning one here would silently make the other's behaviour a bug.
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
    // would make a legitimate design (the browser-local backend reports its
    // connection immediately) fail for no reason.
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

  it('resolves getFile to null for a file that does not exist', async () => {
    // Not a throw: a missing attachment is an ordinary outcome on a canvas
    // whose file was deleted, and the editor renders a placeholder for it.
    const h = await create()

    await expect(h.backend.getFile('no-such-file')).resolves.toBeNull()
    h.cleanup()
  })

  it('sends a local update upstream', async () => {
    const h = await create()
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
    // The editor can request an export or report readiness while the transport
    // is still coming up, or after it dropped. Every implementation either
    // queues or ignores; none may throw into the caller.
    const h = await create()

    expect(() => h.backend.sendClientReady()).not.toThrow()
    expect(() => h.backend.sendExportResponse('req-1', 'data:image/png;base64,AAA')).not.toThrow()
    h.cleanup()
  })
}
