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
import { expect, it, vi } from 'vitest'
import type { SseStreamSource } from '../sse-stream-hub.js'

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

  it('delivers an update for a subscribed document', async () => {
    const h = await create()
    const doc = nextDoc()
    const { updates } = await subscribed(h, doc)

    h.pushUpdate(doc, new Uint8Array([1, 2, 255]))

    await until(() => updates.length === 1)
    expect(updates[0]).toEqual(new Uint8Array([1, 2, 255]))
    h.cleanup()
  })

  it('does not deliver an update addressed to another document', async () => {
    // One stream serves many canvases, so every frame carries its doc key.
    // Without this an edit to one canvas would be applied to another.
    const h = await create()
    const doc = nextDoc()
    const other = nextDoc()
    const { updates } = await subscribed(h, doc)

    h.pushUpdate(other, new Uint8Array([9]))
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
    h.pushUpdate(doc, new Uint8Array([7]))
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
    h.pushUpdate(doc, new Uint8Array([3]))

    await until(() => second.updates.length === 1)
    expect(first.updates).toEqual([])
    h.cleanup()
  })
}
