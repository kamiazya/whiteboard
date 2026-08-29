/**
 * `save` answers the bytes it persisted, because the daemon's sync fan-out
 * needs exactly that update to hand to other subscribers — re-deriving it
 * after the fact would race the next save. `null` means nothing was written,
 * so a caller can skip the fan-out instead of broadcasting a 22-byte empty
 * envelope on every idle save.
 */
import type {
  AppendDeltasInput,
  AppendDeltasResult,
  DeleteDocInput,
  DocumentStore,
  LoadDeltasInput,
  LoadDeltasResult,
  LoadSnapshotInput,
  LoadSnapshotResult,
  ReadFrontierInput,
  ReadFrontierResult,
  ReadSnapshotManifestInput,
  ReadSnapshotManifestResult,
  SaveCompactedSnapshotInput,
  SaveCompactedSnapshotResult,
  SaveSnapshotInput,
  SnapshotManifest,
} from '@kamiazya/whiteboard-ports'
import { docRefKey } from '@kamiazya/whiteboard-ports'
import { LoroDoc } from 'loro-crdt'
import { expect, it } from 'vitest'
import { DocumentStoreWorkspaceDocs } from './document-store-workspace-docs.js'

interface StoredDoc {
  manifest: SnapshotManifest | null
  chunks: SaveSnapshotInput['chunks']
  frontier: Uint8Array<ArrayBuffer>
  deltas: Uint8Array<ArrayBuffer>[]
  /** ADR-0020's fence, implemented for real here: the save path's refusal
   *  branch is only reachable against a store that can refuse. */
  generation: number
}

/** Just enough of a `DocumentStore` for the save/append/compact paths. */
class FakeDocumentStore implements DocumentStore {
  readonly docs = new Map<string, StoredDoc>()

  /**
   * Runs at the TOP of `saveCompactedSnapshot`, which is the one place a
   * rival writer can be made to land between a caller's fence read and its
   * write. Without a seam here the refusal branch is unreachable from a test,
   * and a fallback nothing reaches is a fallback nobody knows is broken.
   */
  beforeCompact: (() => Promise<void>) | undefined

  /**
   * How many folds this store REFUSED.
   *
   * Asserted by the race cases rather than left implicit: both of them pass
   * against a store that never refused anything — the ops survive because
   * nothing raced — so without this the cases would be testing the ordinary
   * path under a name that claims otherwise. The first draft of the fold case
   * did exactly that, and only a mutation check found it.
   */
  refusals = 0

  async loadSnapshot({ docRef }: LoadSnapshotInput): Promise<LoadSnapshotResult> {
    const stored = this.docs.get(docRefKey(docRef))
    if (stored === undefined || stored.manifest === null) return null
    return { manifest: stored.manifest, chunks: stored.chunks, frontier: stored.frontier }
  }

  async readSnapshotManifest({
    docRef,
  }: ReadSnapshotManifestInput): Promise<ReadSnapshotManifestResult> {
    const stored = this.docs.get(docRefKey(docRef))
    if (stored === undefined || stored.manifest === null) return null
    return { manifest: stored.manifest, generation: stored.generation }
  }

  async saveSnapshot({ docRef, manifest, chunks, frontier }: SaveSnapshotInput): Promise<void> {
    const previous = this.docs.get(docRefKey(docRef))
    this.docs.set(docRefKey(docRef), {
      manifest,
      chunks,
      frontier,
      deltas: [],
      generation: (previous?.generation ?? 0) + 1,
    })
  }

  async saveCompactedSnapshot({
    docRef,
    manifest,
    chunks,
    frontier,
    supersededDeltaCount,
    expectedGeneration,
  }: SaveCompactedSnapshotInput): Promise<SaveCompactedSnapshotResult> {
    if (this.beforeCompact !== undefined) await this.beforeCompact()
    const stored = this.docs.get(docRefKey(docRef))
    const current = stored === undefined || stored.manifest === null ? null : stored.generation
    if (current !== expectedGeneration) {
      this.refusals += 1
      return { ok: false, currentGeneration: current }
    }
    const surviving = stored === undefined ? [] : stored.deltas.slice(supersededDeltaCount)
    const generation = (current ?? 0) + 1
    this.docs.set(docRefKey(docRef), {
      manifest,
      chunks,
      frontier,
      deltas: surviving,
      generation,
    })
    return { ok: true, generation }
  }

  async appendDeltas({ docRef, deltaBatch }: AppendDeltasInput): Promise<AppendDeltasResult> {
    const stored = this.docs.get(docRefKey(docRef))
    if (stored === undefined) throw new Error('append without a snapshot')
    stored.deltas.push(...deltaBatch.updates)
    stored.frontier = deltaBatch.newFrontier
    return { frontier: stored.frontier }
  }

  async loadDeltas({ docRef }: LoadDeltasInput): Promise<LoadDeltasResult> {
    const stored = this.docs.get(docRefKey(docRef))
    return { updates: stored?.deltas ?? [], frontier: stored?.frontier ?? new Uint8Array() }
  }

  async readFrontier({ docRef }: ReadFrontierInput): Promise<ReadFrontierResult> {
    const stored = this.docs.get(docRefKey(docRef))
    return stored === undefined ? null : { frontier: stored.frontier }
  }

  async deleteDoc({ docRef }: DeleteDocInput): Promise<void> {
    this.docs.delete(docRefKey(docRef))
  }
}

it('the first save answers bytes that bring an empty peer to the saved state', async () => {
  const docs = new DocumentStoreWorkspaceDocs(new FakeDocumentStore())
  const doc = new LoroDoc()
  doc.getMap('meta').set('title', 'first')
  doc.commit()

  const update = await docs.save('ws-a', doc)
  expect(update).not.toBeNull()
  if (update === null) return
  const peer = new LoroDoc()
  peer.import(update)
  expect(peer.getMap('meta').get('title')).toBe('first')
})

it('an incremental save answers exactly the delta a caught-up peer needs', async () => {
  const docs = new DocumentStoreWorkspaceDocs(new FakeDocumentStore())
  const doc = new LoroDoc()
  doc.getMap('meta').set('title', 'first')
  doc.commit()
  const first = await docs.save('ws-a', doc)
  expect(first).not.toBeNull()
  if (first === null) return
  const peer = new LoroDoc()
  peer.import(first)

  doc.getMap('meta').set('title', 'second')
  doc.commit()
  const second = await docs.save('ws-a', doc)
  expect(second).not.toBeNull()
  if (second === null) return
  peer.import(second)
  expect(peer.getMap('meta').get('title')).toBe('second')
})

it('an idle save answers null', async () => {
  const store = new FakeDocumentStore()
  const docs = new DocumentStoreWorkspaceDocs(store)
  const doc = new LoroDoc()
  doc.getMap('meta').set('title', 'only')
  doc.commit()
  await docs.save('ws-a', doc)

  expect(await docs.save('ws-a', doc)).toBeNull()
})

it('a save that folds the log still answers the delta, not the whole snapshot', async () => {
  const docs = new DocumentStoreWorkspaceDocs(new FakeDocumentStore())
  const doc = new LoroDoc()
  doc.getText('body').insert(0, 'seed')
  doc.commit()
  const first = await docs.save('ws-a', doc)
  expect(first).not.toBeNull()
  if (first === null) return
  const peer = new LoroDoc()
  peer.import(first)

  // Big enough that shouldCompact trips (64 KiB of delta bytes).
  doc.getText('body').insert(0, 'x'.repeat(80_000))
  doc.commit()
  const update = await docs.save('ws-a', doc)
  expect(update).not.toBeNull()
  if (update === null) return
  peer.import(update)
  expect(peer.getText('body').toString()).toBe(doc.getText('body').toString())
})

/**
 * ADR-0020's refusal branch, from both sides it can be reached.
 *
 * The assertion that matters is not that the write was refused — it is that
 * the losing writer's ops are still in the record afterwards. A refusal that
 * dropped them would be the same lost update the fence exists to stop, moved
 * one layer up.
 */
it('keeps its ops when another writer wins the race to create the snapshot', async () => {
  const store = new FakeDocumentStore()
  const rival = new LoroDoc()
  rival.getMap('meta').set('rival', 'yes')
  rival.commit()
  store.beforeCompact = async () => {
    // Once: the rival's own save goes through this same method.
    store.beforeCompact = undefined
    await new DocumentStoreWorkspaceDocs(store).save('ws-a', rival)
  }

  const doc = new LoroDoc()
  doc.getMap('meta').set('mine', 'yes')
  doc.commit()
  await new DocumentStoreWorkspaceDocs(store).save('ws-a', doc)

  expect(store.refusals).toBe(1)
  const reopened = await new DocumentStoreWorkspaceDocs(store).open('ws-a')
  expect(reopened?.getMap('meta').get('rival')).toBe('yes')
  expect(reopened?.getMap('meta').get('mine')).toBe('yes')
})

it('keeps its ops when another writer wins the race to fold the log', async () => {
  const store = new FakeDocumentStore()
  const docs = new DocumentStoreWorkspaceDocs(store)
  const doc = new LoroDoc()
  doc.getMap('meta').set('title', 'first')
  doc.commit()
  await docs.save('ws-a', doc)

  // Past COMPACT_DELTA_BYTES, so the next save takes the FOLD branch rather
  // than the plain append — which is the branch under test, and the one a
  // smaller edit would silently skip.
  doc.getMap('meta').set('bulk', 'x'.repeat(80 * 1024))
  doc.commit()

  const rival = new LoroDoc()
  rival.import(store.docs.get('workspace-tree:ws-a')!.chunks[0]!.bytes)
  // The rival's own change has to be big enough to FOLD too. A small one
  // appends a delta and never touches the snapshot row, so the generation
  // would not move and this case would quietly exercise the ordinary path.
  rival.getMap('meta').set('rival', 'y'.repeat(80 * 1024))
  rival.commit()
  store.beforeCompact = async () => {
    store.beforeCompact = undefined
    await new DocumentStoreWorkspaceDocs(store).save('ws-a', rival)
  }

  await docs.save('ws-a', doc)

  expect(store.refusals).toBe(1)
  const reopened = await new DocumentStoreWorkspaceDocs(store).open('ws-a')
  expect((reopened?.getMap('meta').get('rival') as string | undefined)?.length).toBe(80 * 1024)
  expect(reopened?.getMap('meta').get('title')).toBe('first')
  expect((reopened?.getMap('meta').get('bulk') as string | undefined)?.length).toBe(80 * 1024)
})
