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
  SaveSnapshotInput,
} from '@kamiazya/whiteboard-ports'
import { docRefKey } from '@kamiazya/whiteboard-ports'
import { LoroDoc } from 'loro-crdt'
import { expect, it } from 'vitest'
import { DocumentStoreWorkspaceDocs } from './document-store-workspace-docs.js'

interface StoredDoc {
  manifest: ReadSnapshotManifestResult
  chunks: SaveSnapshotInput['chunks']
  frontier: Uint8Array<ArrayBuffer>
  deltas: Uint8Array<ArrayBuffer>[]
}

/** Just enough of a `DocumentStore` for the save/append/compact paths. */
class FakeDocumentStore implements DocumentStore {
  readonly docs = new Map<string, StoredDoc>()

  async loadSnapshot({ docRef }: LoadSnapshotInput): Promise<LoadSnapshotResult> {
    const stored = this.docs.get(docRefKey(docRef))
    if (stored === undefined || stored.manifest === null) return null
    return { manifest: stored.manifest, chunks: stored.chunks, frontier: stored.frontier }
  }

  async readSnapshotManifest({
    docRef,
  }: ReadSnapshotManifestInput): Promise<ReadSnapshotManifestResult> {
    return this.docs.get(docRefKey(docRef))?.manifest ?? null
  }

  async saveSnapshot({ docRef, manifest, chunks, frontier }: SaveSnapshotInput): Promise<void> {
    this.docs.set(docRefKey(docRef), { manifest, chunks, frontier, deltas: [] })
  }

  async saveCompactedSnapshot({
    docRef,
    manifest,
    chunks,
    frontier,
    supersededDeltaCount,
  }: SaveCompactedSnapshotInput): Promise<void> {
    const stored = this.docs.get(docRefKey(docRef))
    const surviving = stored === undefined ? [] : stored.deltas.slice(supersededDeltaCount)
    this.docs.set(docRefKey(docRef), { manifest, chunks, frontier, deltas: surviving })
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
