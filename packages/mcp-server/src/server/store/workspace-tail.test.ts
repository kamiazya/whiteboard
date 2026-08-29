import { DocumentStoreWorkspaceDocs } from '@kamiazya/whiteboard-workspace-index'
import { LoroDoc } from 'loro-crdt'
import { describe, expect, it, vi } from 'vitest'
import { captureLogsForTests } from '../log.js'
import { InMemoryDocumentStore } from './inmemory/in-memory-document-store.js'
import {
  createWorkspaceTail,
  resolveWorkspaceTailIntervalMs,
  WORKSPACE_TAIL_INTERVAL_ENV,
} from './workspace-tail.js'

const WS = 'ws-tail'

function harness() {
  const store = new InMemoryDocumentStore()
  const docs = new DocumentStoreWorkspaceDocs(store)
  const live = new Map<string, LoroDoc>()
  const emitted: { workspaceId: string; update: Uint8Array }[] = []
  let subscribed: string[] = []
  const liveDoc = async (workspaceId: string): Promise<LoroDoc> => {
    const existing = live.get(workspaceId)
    if (existing !== undefined) return existing
    const opened = (await docs.open(workspaceId)) ?? new LoroDoc()
    live.set(workspaceId, opened)
    return opened
  }
  const tail = createWorkspaceTail({
    subscribedWorkspaces: () => subscribed,
    docs,
    liveDoc,
    emit: (workspaceId, update) => emitted.push({ workspaceId, update }),
    intervalMs: 50,
  })
  return {
    docs,
    live,
    liveDoc,
    emitted,
    tail,
    subscribe: (...ids: string[]) => {
      subscribed = ids
    },
  }
}

/** A writer that is NOT this instance: its own doc, its own saves. */
async function writeFrom(
  docs: DocumentStoreWorkspaceDocs,
  workspaceId: string,
  key: string,
  value: string,
): Promise<void> {
  const doc = (await docs.open(workspaceId)) ?? new LoroDoc()
  doc.getMap('meta').set(key, value)
  doc.commit()
  await docs.save(workspaceId, doc)
}

describe('createWorkspaceTail', () => {
  /**
   * The first pass BASELINES rather than replays.
   *
   * A socket is sent the workspace snapshot when it connects, so everything
   * the record already holds has been delivered. A tail that emitted the whole
   * log on its first pass would re-send all of it — harmless by CRDT
   * semantics, and a large enough waste to look like a bug on a big workspace.
   */
  it('emits nothing on the first pass over a newly subscribed workspace', async () => {
    const h = harness()
    await writeFrom(h.docs, WS, 'existing', '1')
    h.subscribe(WS)

    await h.tail.pollOnce()
    expect(h.emitted).toEqual([])
  })

  it('emits what another instance wrote, and imports it into the live document', async () => {
    const h = harness()
    await writeFrom(h.docs, WS, 'existing', '1')
    h.subscribe(WS)
    await h.tail.pollOnce()

    // Materialised explicitly. The baseline pass never asks for a live doc,
    // so reading the harness map here answers `undefined` — and every
    // assertion below written with `?.` would then pass by being skipped,
    // including the one that is supposed to establish the precondition.
    const held = await h.liveDoc(WS)
    // Level with this instance, the way a connected client is: every socket
    // is sent the workspace snapshot on connect. Starting a peer EMPTY would
    // be a different test — the emitted bytes are a delta, and a recipient
    // without the base holds its ops pending rather than applying them.
    const peer = new LoroDoc()
    peer.import(held.export({ mode: 'snapshot' }))

    await writeFrom(h.docs, WS, 'remote', '1')
    // The precondition, asserted rather than assumed: this instance's live
    // doc does not have the other instance's write yet.
    expect(held.getMap('meta').get('existing')).toBe('1')
    expect(held.getMap('meta').get('remote')).toBeUndefined()

    await h.tail.pollOnce()
    expect(h.emitted.length).toBeGreaterThan(0)
    expect(h.emitted.every((entry) => entry.workspaceId === WS)).toBe(true)
    expect(held.getMap('meta').get('remote')).toBe('1')

    // The fan-out's actual promise: a client that was level before the write
    // is level again after importing what was emitted.
    for (const entry of h.emitted) peer.import(entry.update)
    expect(peer.getMap('meta').toJSON()).toEqual(held.getMap('meta').toJSON())
  })

  it('emits nothing further when nothing was written', async () => {
    const h = harness()
    await writeFrom(h.docs, WS, 'existing', '1')
    h.subscribe(WS)
    await h.tail.pollOnce()
    await h.tail.pollOnce()
    await h.tail.pollOnce()
    expect(h.emitted).toEqual([])
  })

  /**
   * A workspace with no audience is forgotten, so the next subscription
   * baselines again instead of replaying everything written while nobody was
   * listening — the same reason the first pass baselines.
   */
  it('re-baselines a workspace whose audience left and came back', async () => {
    const h = harness()
    await writeFrom(h.docs, WS, 'existing', '1')
    h.subscribe(WS)
    await h.tail.pollOnce()

    h.subscribe()
    await h.tail.pollOnce()
    await writeFrom(h.docs, WS, 'while-away', '1')

    h.subscribe(WS)
    await h.tail.pollOnce()
    expect(h.emitted).toEqual([])
  })

  it('keeps polling the other workspaces when one of them throws', async () => {
    const h = harness()
    await writeFrom(h.docs, WS, 'existing', '1')
    await writeFrom(h.docs, 'ws-other', 'existing', '1')
    h.subscribe('ws-broken', WS)

    const captured = captureLogsForTests('warning')
    const broken = vi
      .spyOn(h.docs, 'readCursor')
      .mockImplementation(async (workspaceId: string) => {
        if (workspaceId === 'ws-broken') throw new Error('unreachable')
        return { generation: null, afterSeq: null }
      })
    try {
      await h.tail.pollOnce()
    } finally {
      broken.mockRestore()
      captured.restore()
    }
    // Reported rather than swallowed: a workspace that has silently stopped
    // following is indistinguishable from one nobody is writing to.
    expect(
      captured.records.some(
        (record) => record.scope === 'workspace-tail' && record.level === 'warning',
      ),
    ).toBe(true)

    await writeFrom(h.docs, WS, 'remote', '1')
    await h.tail.pollOnce()
    // The healthy workspace was baselined on the first pass despite its
    // neighbour throwing, so this pass has something to emit.
    expect(h.emitted.length).toBeGreaterThan(0)
  })
})

describe('resolveWorkspaceTailIntervalMs', () => {
  it('is off when the variable is absent or empty', () => {
    expect(resolveWorkspaceTailIntervalMs({})).toBeNull()
    expect(resolveWorkspaceTailIntervalMs({ [WORKSPACE_TAIL_INTERVAL_ENV]: '' })).toBeNull()
    expect(resolveWorkspaceTailIntervalMs({ [WORKSPACE_TAIL_INTERVAL_ENV]: '   ' })).toBeNull()
  })

  it('reads a plain interval', () => {
    expect(resolveWorkspaceTailIntervalMs({ [WORKSPACE_TAIL_INTERVAL_ENV]: '2000' })).toBe(2000)
  })

  it('is off for zero, which is how an operator spells "stop following"', () => {
    expect(resolveWorkspaceTailIntervalMs({ [WORKSPACE_TAIL_INTERVAL_ENV]: '0' })).toBeNull()
  })

  /**
   * A mistyped value is OFF rather than an interval nobody intended. `2s`
   * under `Number.parseInt` would be 2 — a pass every two milliseconds
   * against the database, which is the failure mode strictness exists for.
   */
  it('is off for anything that is not a bare integer', () => {
    for (const raw of ['2s', '2.5', '-1', 'fast', '1e3', ' 2000ms']) {
      expect(resolveWorkspaceTailIntervalMs({ [WORKSPACE_TAIL_INTERVAL_ENV]: raw })).toBeNull()
    }
  })
})
