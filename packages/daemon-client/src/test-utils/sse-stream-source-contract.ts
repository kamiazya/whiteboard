/**
 * The behavioural contract every `SseStreamSource` must satisfy, written once
 * and run against each implementation.
 *
 * It exists because a defect got all the way to a merged branch that only a
 * suite shaped like this would have caught: `SseStreamSource` has two
 * implementations — the hub, and a SharedWorker-backed proxy — and every test
 * drove the hub. The proxy is the one the app actually ships, and it addressed
 * its control messages with a stream the daemon had never heard of, so
 * `client_ready` was dropped and viewport requests were never delivered.
 *
 * Per-implementation suites cannot prevent that: the gap is the combination
 * nobody wrote a test for, and the missing combination is invisible from
 * inside either suite. Only a contract run against every implementation makes
 * a new implementation's untested behaviour a failure rather than a silence.
 */
import { LoroDoc } from 'loro-crdt'
import { expect, it, vi } from 'vitest'
import type { SseStreamSource } from '../sse-stream-hub.js'

/**
 * Real Loro bytes, so an implementation that merges the push through a replica
 * produces something and one that forwards it verbatim stays comparable.
 * Arbitrary bytes would be dropped by the replica as unparseable and the case
 * would pass or fail for the wrong reason.
 */
const LORO_UPDATE: Uint8Array = (() => {
  const doc = new LoroDoc()
  doc.getMap('contract').set('pushed', 'through')
  doc.commit()
  return doc.export({ mode: 'update' })
})()

/**
 * A running implementation plus the daemon-side observations the contract
 * asserts against. Each implementation supplies its own plumbing (a fake fetch,
 * or a real SharedWorker against a mock server); the contract only ever talks
 * through this.
 */
export interface SseStreamSourceHarness {
  source: SseStreamSource
  /** Emit an `update` frame from the daemon for `doc`. */
  pushUpdate(doc: string, bytes: Uint8Array): void
  /** Emit a server text frame from the daemon for `doc`. */
  pushText(doc: string, raw: string): void
  /** Documents the daemon has been asked to route into the stream. */
  subscribedDocs(): string[]
  /** Documents the daemon has been asked to stop routing. */
  unsubscribedDocs(): string[]
  /** Control messages the daemon received, with the stream each was sent for. */
  controlMessages(): { streamId: string; doc: string; message: unknown }[]
  /** Stream ids the daemon minted for this source. */
  openedStreamIds(): string[]
  /**
   * Update bodies the daemon received on its own canvas route, with the
   * document each was addressed to — reassembled from the URL, since that
   * addressing is half of what the push contract asserts.
   */
  daemonWrites(): { doc: string; body: Uint8Array }[]
  /**
   * Install pre-existing content for `doc` on the fake daemon's snapshot
   * route, as Loro update/snapshot bytes. "Pre-existing" is the point: the
   * snapshot contract is about state the source never saw arrive.
   */
  seedDaemonState(doc: string, bytes: Uint8Array): void
  /** Wait until the daemon has an open stream ready to receive frames. */
  ready(): Promise<void>
  /** End the current stream the way a dropped connection does. */
  dropStream(): void
  cleanup(): void
}

/**
 * A document key per invocation. Some implementations cannot be torn down (a
 * SharedWorker has no terminate), so one case's traffic must not be readable
 * as another's.
 */
let seq = 0
const nextDoc = (): string => `contract-ws/doc-${++seq}`

const until = (predicate: () => boolean): Promise<void> =>
  vi.waitFor(() => expect(predicate()).toBe(true)) as unknown as Promise<void>

/** A real window in which a wrong delivery could arrive, for asserting none does. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 50))

function collect(source: SseStreamSource, doc: string) {
  const updates: Uint8Array[] = []
  const messages: string[] = []
  const off = source.subscribe(doc, {
    onUpdate: (b) => updates.push(b),
    onMessage: (m) => messages.push(m),
  })
  return { updates, messages, off }
}

/**
 * Subscribe and wait until the daemon has actually been told to route the
 * document. A frame pushed before that is legitimately dropped — the
 * subscription may still be in flight (across a port, for the worker-backed
 * source) — so pushing without this asserts a race rather than the behaviour.
 */
async function subscribed(h: SseStreamSourceHarness, doc: string) {
  const collected = collect(h.source, doc)
  await h.ready()
  await until(() => h.subscribedDocs().includes(doc))
  return collected
}

/**
 * Registers the contract cases. Call inside a `describe` for one implementation.
 *
 * `create` is invoked per case, so each gets a fresh source where the
 * implementation allows one.
 */
export function sseStreamSourceContract(
  create: () => SseStreamSourceHarness | Promise<SseStreamSourceHarness>,
): void {
  it('announces a document to the daemon when it is first subscribed', async () => {
    const h = await create()
    const doc = nextDoc()
    collect(h.source, doc)

    await until(() => h.subscribedDocs().includes(doc))
    h.cleanup()
  })

  it('delivers a daemon change to a subscribed listener', async () => {
    // Asserted by STATE, not by byte identity: the hub relays the daemon's
    // frame verbatim, while the worker-backed source delivers its replica's
    // delta — same state, not the same bytes. Valid Loro bytes on purpose:
    // the replica drops a frame it cannot merge, so garbage bytes would make
    // this case pass or fail on frame policy rather than on delivery.
    const h = await create()
    const doc = nextDoc()
    const { updates } = await subscribed(h, doc)

    h.pushUpdate(doc, LORO_UPDATE)

    await until(() => updates.length >= 1)
    const reconstructed = new LoroDoc()
    for (const bytes of updates) reconstructed.import(bytes)
    expect(reconstructed.getMap('contract').get('pushed')).toBe('through')
    h.cleanup()
  })

  it('does not deliver an update addressed to another document', async () => {
    // One stream serves many documents, so every frame carries its doc key.
    // Without this an edit to one canvas would be applied to another.
    const h = await create()
    const doc = nextDoc()
    const other = nextDoc()
    const { updates } = await subscribed(h, doc)

    // Valid Loro bytes: a replica-backed source drops garbage regardless of
    // routing, which would let a broken router pass this case vacuously.
    h.pushUpdate(other, LORO_UPDATE)
    await settle()

    expect(updates).toEqual([])
    h.cleanup()
  })

  it('delivers a text message for a subscribed document but not for another', async () => {
    const h = await create()
    const doc = nextDoc()
    const other = nextDoc()
    const { messages } = await subscribed(h, doc)

    h.pushText(other, '{"type":"head_changed","head":"nope"}')
    await settle()
    expect(messages).toEqual([])

    h.pushText(doc, '{"type":"head_changed","head":"yes"}')
    await until(() => messages.length === 1)
    expect(messages[0]).toContain('yes')
    h.cleanup()
  })

  it('sends a control message under the stream id its own stream was opened with', async () => {
    // The defect this contract was written for. Whoever owns the stream must
    // answer for the control message: the daemon addresses it by stream, and a
    // caller naming a stream the daemon never opened has its message dropped —
    // silently, since the send is fire-and-forget.
    const h = await create()
    const doc = nextDoc()
    await subscribed(h, doc)

    h.source.sendMessage(doc, { type: 'client_ready' })

    await until(() => h.controlMessages().some((m) => m.doc === doc))
    const sent = h.controlMessages().find((m) => m.doc === doc)
    expect(sent?.message).toEqual({ type: 'client_ready' })
    expect(h.openedStreamIds()).toContain(sent?.streamId)
    h.cleanup()
  })

  it('gets a pushed update to the daemon, addressed by workspace and path', async () => {
    // Both implementations reach the daemon, by different routes — the hub
    // posts, the worker-backed source hands the bytes to a replica that posts
    // — and a caller cannot tell which it has. If either stopped arriving, an
    // edit would be applied locally, shown to the user, echoed to sibling
    // tabs, and never persisted: the failure looks exactly like success until
    // the page is reloaded.
    const h = await create()
    const doc = nextDoc()
    await subscribed(h, doc)

    h.source.push(doc, LORO_UPDATE)

    await until(() => h.daemonWrites().some((w) => w.doc === doc))
    const write = h.daemonWrites().find((w) => w.doc === doc)
    // Reconstructed, not compared byte-for-byte: an implementation that merges
    // through a replica sends that replica's delta, which carries the same
    // state without being the same bytes.
    const received = new LoroDoc()
    received.import(write?.body as Uint8Array)
    expect(received.getMap('contract').get('pushed')).toBe('through')
    h.cleanup()
  })

  it('answers a snapshot with state the source did not witness arrive', async () => {
    // The stream carries only incremental updates from subscription onward,
    // so "the document's current state" is a question the stream cannot
    // answer. The hub asks the daemon; the worker-backed source seeds its
    // replica once and answers from memory. Either way, a document with
    // PRE-EXISTING content must come back whole — an implementation that
    // reconstructs from stream traffic alone passes every other case in this
    // file and still hands a forking tab partial truth.
    const h = await create()
    const doc = nextDoc()
    h.seedDaemonState(doc, LORO_UPDATE)
    // BEFORE any subscription, because that is the order the backend uses: it
    // seeds from the snapshot first so the stream's deltas have something to
    // land on. An implementation that only answers documents it already has
    // listeners for deadlocks that first open.
    const bytes = await h.source.snapshot(doc)
    expect(bytes).not.toBeNull()
    const reconstructed = new LoroDoc()
    reconstructed.import(bytes as Uint8Array)
    expect(reconstructed.getMap('contract').get('pushed')).toBe('through')
    h.cleanup()
  })

  it('tells its subscribers when the stream drops', async () => {
    // A subscriber told only about frames cannot tell "nothing has changed"
    // from "nothing is arriving", so a dropped stream looks exactly like a
    // quiet one and the UI keeps reporting a connection that is gone.
    const h = await create()
    const doc = nextDoc()
    const states: boolean[] = []
    h.source.subscribe(doc, {
      onUpdate: () => {},
      onMessage: () => {},
      onConnectionChange: (connected) => states.push(connected),
    })
    await until(() => states.includes(true))
    // Measured from here on: subscribing already records the state at join
    // time, which on a fresh source is `false`. Asserting `includes(false)`
    // over the whole array would pass without the drop emitting anything.
    const before = states.length

    h.dropStream()

    await until(() => states.slice(before).includes(false))
    h.cleanup()
  })

  it('stops delivering to a listener that unsubscribed', async () => {
    const h = await create()
    const doc = nextDoc()
    const { updates, off } = await subscribed(h, doc)

    off()
    await until(() => h.unsubscribedDocs().includes(doc))
    // Valid Loro bytes for the same reason as the other-document case: a
    // replica would drop garbage even with the unsubscribe broken.
    h.pushUpdate(doc, LORO_UPDATE)
    await settle()

    expect(updates).toEqual([])
    h.cleanup()
  })

  it('keeps delivering while another listener for the same document remains', async () => {
    // Refcounting is per document, not per listener: releasing one canvas view
    // must not silence a second one watching the same document.
    const h = await create()
    const doc = nextDoc()
    const first = await subscribed(h, doc)
    const second = collect(h.source, doc)

    first.off()
    h.pushUpdate(doc, LORO_UPDATE)

    await until(() => second.updates.length >= 1)
    expect(first.updates).toEqual([])
    h.cleanup()
  })
}
