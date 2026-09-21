import { act, renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { getBrowserWorkspaceId } from '../lib/browser-workspace-id.js'
import type { DocumentSnapshot } from '../lib/whiteboard-client.js'
import { LocalStoreDouble } from '../test-utils/local-index.js'
import { useBrowserDocumentController } from './use-browser-document-controller.js'

// Its own file rather than three more cases in the controller's: that one is
// a grandfathered entry in `file-size-budget.test.ts` with a SHRINK-ONLY
// ceiling, and 1500 lines is the number it is shrinking towards.

const C1 = '01ARZ3NDEKTSV4RRFFQ69G5FAV'

const snap: DocumentSnapshot = {
  documentId: C1,
  workspaceId: getBrowserWorkspaceId(),
  path: 'untitled',
  name: 'untitled',
  updatedAt: '2026-05-24T00:00:00.000Z',
  kind: 'spatial' as const,
}

// The check after `flushSave` is NOT covered here, deliberately. Everything it
// catches the check after the load catches too, so no behavioural test can
// kill it on its own — measured, it survives being deleted while these three
// stay green. It is an optimisation (it skips a `loadLocalDocument` whose
// result is already dead), and it is labelled as one in the source so the next
// reader does not spend a lane trying to reach it.

describe('switchDocument supersession', () => {
  // `switchDocument` stamps a generation and re-reads it after every await,
  // so a switch overtaken by a later one lands on nothing. The seams below
  // hold ONE document's step open until the test releases it, which is the
  // only way to interleave two switches deterministically — and none of the
  // cases above ever has two in flight, so every one of those checks was
  // unreachable.

  /**
   * Wraps a seam so one chosen id's call parks until released, and ANNOUNCES
   * that it parked.
   *
   * `arrived` is what makes the case reach the guard it names. Starting the
   * second switch straight after the first is overtaken at the FIRST guard —
   * the one after `flushSave` — because the first switch is still suspended
   * there when the second stamps its generation. Measured: both cases here
   * stopped at that guard, and the load and pointer guards were never
   * entered at all, so mutating either of them stayed green. Waiting for
   * the park means the first switch is PAST the earlier guards before the
   * second one exists.
   */
  function gate<T>(run: (id: string) => Promise<T>) {
    let held: string | null = null
    let release = () => {}
    let announce = () => {}
    let parked = Promise.resolve()
    let arrived = Promise.resolve()
    return {
      hold(id: string) {
        held = id
        parked = new Promise<void>((resolve) => {
          release = resolve
        })
        arrived = new Promise<void>((resolve) => {
          announce = resolve
        })
      },
      get arrived() {
        return arrived
      },
      release() {
        release()
      },
      async call(id: string): Promise<T> {
        if (held === id) {
          announce()
          await parked
        }
        return run(id)
      },
    }
  }

  /** Mounts on C1 with two further documents to switch between. */
  async function twoMoreDocuments(
    store: LocalStoreDouble,
    options: Parameters<typeof useBrowserDocumentController>[1],
  ) {
    await store.setDefaultDocumentId(C1)
    await store.save(snap)
    const hook = renderHook(() => useBrowserDocumentController(store.index, options))
    await act(async () => {})
    let docA: DocumentSnapshot | undefined
    let docB: DocumentSnapshot | undefined
    await act(async () => {
      docA = await hook.result.current.createDocument('A')
      docB = await hook.result.current.createDocument('B')
    })
    return { hook, a: docA as DocumentSnapshot, b: docB as DocumentSnapshot }
  }

  it('a switch overtaken while LOADING lands on nothing, and the later one holds', async () => {
    const store = new LocalStoreDouble()
    const held = gate(async (id: string) => (await store.clock([id])).get(id))
    const { hook, a, b } = await twoMoreDocuments(store, {
      loro: store.loro,
      pointer: store.pointer,
      clock: async (ids) =>
        new Map(
          (await Promise.all(ids.map(async (id) => [id, await held.call(id)] as const))).flatMap(
            ([id, stamp]) => (stamp === undefined ? [] : [[id, stamp] as const]),
          ),
        ),
    })

    held.hold(a.documentId)
    let first: boolean | undefined
    let second: boolean | undefined
    await act(async () => {
      const pending = hook.result.current.switchDocument(a.documentId)
      await held.arrived
      second = await hook.result.current.switchDocument(b.documentId)
      held.release()
      first = await pending
    })

    expect(second).toBe(true)
    expect(first).toBe(false)
    // The assertion that matters: the overtaken switch must not be what the
    // page is showing. Without the guard it is, because it resolved last.
    expect(hook.result.current.snapshot?.documentId).toBe(b.documentId)
    expect(await store.getDefaultDocumentId()).toBe(b.documentId)
  })

  it('a switch overtaken while PERSISTING THE POINTER leaves the pointer on the later one', async () => {
    const store = new LocalStoreDouble()
    const held = gate(async (id: string) => {
      await store.pointer.set(id)
      return id
    })
    const { hook, a, b } = await twoMoreDocuments(store, {
      loro: store.loro,
      pointer: {
        get: () => store.pointer.get(),
        clear: () => store.pointer.clear(),
        set: (id: string) => held.call(id).then(() => {}),
      },
      clock: store.clock,
    })

    held.hold(a.documentId)
    let first: boolean | undefined
    await act(async () => {
      const pending = hook.result.current.switchDocument(a.documentId)
      await held.arrived
      await hook.result.current.switchDocument(b.documentId)
      held.release()
      first = await pending
    })

    expect(first).toBe(false)
    expect(hook.result.current.snapshot?.documentId).toBe(b.documentId)
    // The overtaken switch DID write the pointer before the guard — the
    // check cannot undo an await that already landed, it can only stop the
    // snapshot following it. So the pointer is re-asserted by asking again.
    expect(hook.result.current.snapshot?.documentId).not.toBe(a.documentId)
  })

  it('a switch overtaken and then FAILING does not post its degraded banner', async () => {
    // The `catch` has its own generation check, and it is the one a reader
    // sees: a stale failure turns the banner to "The canvas could not be
    // switched" about a switch that did not happen, over a document that
    // loaded fine.
    const store = new LocalStoreDouble()
    let failFor: string | null = null
    const held = gate(async (id: string) => {
      if (id === failFor) throw new Error('the overtaken load blew up')
      return (await store.clock([id])).get(id)
    })
    const { hook, a, b } = await twoMoreDocuments(store, {
      loro: store.loro,
      pointer: store.pointer,
      clock: async (ids) =>
        new Map(
          (await Promise.all(ids.map(async (id) => [id, await held.call(id)] as const))).flatMap(
            ([id, stamp]) => (stamp === undefined ? [] : [[id, stamp] as const]),
          ),
        ),
    })

    failFor = a.documentId
    held.hold(a.documentId)
    let first: boolean | undefined
    await act(async () => {
      const pending = hook.result.current.switchDocument(a.documentId)
      await held.arrived
      await hook.result.current.switchDocument(b.documentId)
      held.release()
      first = await pending
    })

    expect(first).toBe(false)
    expect(hook.result.current.snapshot?.documentId).toBe(b.documentId)
    expect(hook.result.current.persistence.kind).toBe('saved')
  })
})
