/**
 * Compaction, against real IndexedDB and real Loro bytes.
 *
 * jsdom has neither, and the property under test is precisely that the bytes
 * a fresh open replays stop growing — which is only observable once both are
 * real.
 */
import { readSpatialCanvas, writeSpatialCanvas } from '@kamiazya/whiteboard-loro-adapter'
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import type { DocRef } from '@kamiazya/whiteboard-ports'
import { COMPACT_DELTA_BYTES, chunkSnapshot, reassembleSnapshot } from '@kamiazya/whiteboard-ports'
import { LoroDoc } from 'loro-crdt'
import { expect, it } from 'vitest'
import { resolveBrowserWorkspaceId } from './browser-workspace-id.js'
import { IdbDocumentStore } from './idb-document-store.js'
import { LoroStore } from './loro-store.js'

function canvasWith(n: number, nudge = 0): SpatialCanvas {
  return {
    nodes: Array.from({ length: n }, (_, i) => ({
      id: `n${i}`,
      type: 'text' as const,
      x: (i % 10) * 220 + nudge,
      y: Math.floor(i / 10) * 140,
      width: 200,
      height: 120,
      text: `Node ${i} — a line of text long enough to be realistic.`,
    })),
    edges: [],
  } as SpatialCanvas
}

function totalBytes(deltas: readonly Uint8Array[] | undefined): number {
  return (deltas ?? []).reduce((sum, d) => sum + d.byteLength, 0)
}

it('folds the delta log once it passes the budget, keeping the content', async () => {
  // Shared 'whiteboard' db, no isolation helper: `LoroStore` reads
  // `getBrowserWorkspaceId()` to build a `DocRef` (unused for `document:`
  // keys, but still read), so it has to be resolved once against whichever
  // single workspace this shared database already holds.
  await resolveBrowserWorkspaceId()
  const store = new LoroStore()
  const id = `doc-${Math.trunc(performance.now() * 1000)}`

  const doc = new LoroDoc()
  writeSpatialCanvas(doc, canvasWith(20))
  doc.commit()
  await store.save(id, doc.export({ mode: 'snapshot' }))

  let version = doc.version()
  let appended = 0
  let pushed = 0
  // Past the budget with room to spare, so the assertion is not on its edge.
  while (pushed < COMPACT_DELTA_BYTES * 2) {
    appended += 1
    if (appended > 2000) throw new Error('never reached the budget')
    writeSpatialCanvas(doc, canvasWith(20, appended))
    doc.commit()
    const delta = doc.export({ mode: 'update', from: version })
    version = doc.version()
    pushed += delta.byteLength
    await store.appendDelta(id, delta)
  }

  const loaded = await store.load(id)
  expect(loaded.kind).toBe('ok')
  if (loaded.kind !== 'ok') return

  // The log is folded away, not merely trimmed.
  expect(totalBytes(loaded.deltas)).toBeLessThanOrEqual(COMPACT_DELTA_BYTES)

  // And the content survived the fold: the last edit is still there.
  const reopened = new LoroDoc()
  reopened.import(loaded.snapshot)
  for (const d of loaded.deltas ?? []) reopened.import(d)
  expect(readSpatialCanvas(reopened).nodes[0]?.x).toBe(canvasWith(20, appended).nodes[0]?.x)
}, 120_000)

// The guard the fold rests on: bytes that will not replay are kept exactly as
// they were. Reachable, not defensive — appendDelta only checks the envelope
// STRUCTURALLY (instanceof Uint8Array); it never deep-validates the stored
// snapshot or the deltas already there, and the repo's own loro-store tests
// seed a v:1 envelope carrying invalid Loro bytes.
it('keeps a log it cannot replay rather than dropping the edits', async () => {
  await resolveBrowserWorkspaceId()
  const store = new LoroStore()
  const id = `unfoldable-${Math.trunc(performance.now() * 1000)}`

  const doc = new LoroDoc()
  writeSpatialCanvas(doc, canvasWith(5))
  doc.commit()
  await store.save(id, doc.export({ mode: 'snapshot' }))

  // Past the budget in one go, and not Loro bytes at all.
  const garbage = new Uint8Array(COMPACT_DELTA_BYTES + 1).fill(7)
  await expect(store.appendDelta(id, garbage)).resolves.toBeUndefined()

  const loaded = await store.load(id)
  // load()'s deep validation refuses it — which is the point: the bytes are
  // still there to be refused, rather than silently gone.
  expect(loaded.kind).toBe('corrupt-delta')
}, 120_000)

/**
 * The cross-tab arm of ADR-0020, at the layer that recovers from it.
 *
 * The port's own conformance suite proves the STORE refuses a fold whose
 * generation another writer already replaced. What it cannot say is whether
 * this CALLER does the right thing with that refusal — `appendDelta` answers
 * it by re-issuing the delta as an ordinary append, so losing the race costs
 * a fold and never an edit, and nothing exercised that branch.
 *
 * The arrangement is FORCED, not raced, and that is the whole design. Two
 * instances started together do not reach the fence: measured on the daemon
 * side, whose fold has the same shape, `Promise.all` leaves the second
 * writer's read landing after the first writer's write, so its fold already
 * contains the other's ops and disabling the fence changed nothing but the
 * counters. So a wrapper puts a competing fold inside the window between
 * this store's read and its own write, which is the ordering two real tabs
 * produce and a single event loop will not.
 */
it('re-appends the edit when another tab folds first', async () => {
  await resolveBrowserWorkspaceId()
  const dbName = `race-${Math.trunc(performance.now() * 1000)}`
  const id = 'doc'
  const inner = new IdbDocumentStore(dbName)
  const docRef: DocRef = {
    kind: 'document',
    workspaceId: await resolveBrowserWorkspaceId(),
    documentId: id,
  }

  // What the subject's own saveCompactedSnapshot answered. The refusal is
  // the reason this test exists, so it is asserted rather than assumed —
  // without it a hook that silently failed to fire would leave a test that
  // passes while exercising nothing.
  const outcomes: boolean[] = []
  let competeOnce: (() => Promise<void>) | undefined

  const store = new LoroStore(dbName, {
    ...inner,
    saveSnapshot: (i) => inner.saveSnapshot(i),
    loadSnapshot: (i) => inner.loadSnapshot(i),
    loadDeltas: (i) => inner.loadDeltas(i),
    appendDeltas: (i) => inner.appendDeltas(i),
    readSnapshotManifest: (i) => inner.readSnapshotManifest(i),
    readFrontier: (i) => inner.readFrontier(i),
    deleteDoc: (i) => inner.deleteDoc(i),
    async saveCompactedSnapshot(input) {
      // Fires once, immediately before the fold's write reaches the store —
      // the same placement the daemon's own model needs.
      const compete = competeOnce
      competeOnce = undefined
      if (compete !== undefined) await compete()
      const result = await inner.saveCompactedSnapshot(input)
      outcomes.push(result.ok)
      return result
    },
  })

  const doc = new LoroDoc()
  writeSpatialCanvas(doc, canvasWith(20))
  doc.commit()
  await store.save(id, doc.export({ mode: 'snapshot' }))

  // Armed BEFORE the first append, because the fold fires on whichever append
  // first carries the log past the budget — arming later straddles nothing and
  // the test passes on a fold that was never contested. That is not
  // hypothetical: it is what the first version of this test did, and the
  // refusal assertion below is the only thing that noticed.
  competeOnce = async () => {
    // Another tab folds the log AS IT STANDS — without this edit, which
    // has not been written anywhere yet. Reading the generation here is
    // what makes its own write succeed and the subject's stale.
    const header = await inner.readSnapshotManifest({ docRef })
    if (header === null) throw new Error('expected a stored snapshot')
    const stored = await inner.loadSnapshot({ docRef })
    if (stored === null) throw new Error('expected snapshot chunks')
    const existing = (await inner.loadDeltas({ docRef, afterSeq: null })).updates
    const other = new LoroDoc()
    other.import(reassembleSnapshot(stored.manifest, stored.chunks))
    for (const d of existing) other.import(d)
    const folded = other.export({ mode: 'snapshot' })
    const written = await inner.saveCompactedSnapshot({
      docRef,
      ...chunkSnapshot(folded, 1_000_000),
      frontier: new Uint8Array(),
      expectedGeneration: header.generation,
      supersededDeltaCount: existing.length,
    })
    if (!written.ok) throw new Error('the competing fold was itself refused')
  }

  let version = doc.version()
  let appended = 0
  let lastDeltaBytes = 0
  while (outcomes.length === 0) {
    appended += 1
    if (appended > 2000) throw new Error('never reached the budget')
    writeSpatialCanvas(doc, canvasWith(20, appended))
    doc.commit()
    const delta = doc.export({ mode: 'update', from: version })
    version = doc.version()
    lastDeltaBytes = delta.byteLength
    await store.appendDelta(id, delta)
  }

  // Exactly one refusal: the subject folded, the other tab had already
  // replaced the snapshot, and the fence rejected the stale generation.
  expect(outcomes, 'the subject never met a refusal — the straddle did not happen').toEqual([false])

  const loaded = await store.load(id)
  expect(loaded.kind).toBe('ok')
  if (loaded.kind !== 'ok') return

  // What went back into the log is the EDIT, not the fold. Re-appending the
  // folded snapshot instead would also preserve the content — the fold
  // contains it — so no content assertion can see the difference, and this is
  // the only thing that does. It matters because the folded snapshot is the
  // whole document: a store that re-appended it would permanently inflate the
  // log of every document that ever lost a race, which is the opposite of
  // what compaction is for.
  const log = loaded.deltas ?? []
  expect(log.at(-1)?.byteLength, 'the fallback re-appended the fold, not the edit').toBe(
    lastDeltaBytes,
  )

  // The edit the subject was folding when it lost survived anyway, as an
  // ordinary append. That is the whole guarantee.
  const reopened = new LoroDoc()
  reopened.import(loaded.snapshot)
  for (const d of loaded.deltas ?? []) reopened.import(d)
  expect(readSpatialCanvas(reopened).nodes[0]?.x).toBe(canvasWith(20, appended).nodes[0]?.x)
}, 120_000)
