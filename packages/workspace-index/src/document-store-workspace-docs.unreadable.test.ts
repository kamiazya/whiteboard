/**
 * What `open` raises when the record is there and cannot be made sense of.
 *
 * The distinction this pins is not cosmetic. `open` has two ways to fail —
 * the store could not be read (a transaction aborted, a connection blocked),
 * and the bytes the store DID return are not a document — and a caller has to
 * tell them apart to say anything true to a person: one is "storage is having
 * a moment", the other is "this record is damaged". Until the CRDT's refusal
 * was typed, the second arrived as whatever loro-crdt threw, indistinguishable
 * from the first, so `apps/web`'s backend classified every failure as damage
 * and showed a healthy document as unreadable.
 *
 * Typed HERE rather than at the call site because this is the only layer that
 * knows both facts at once: that the bytes came out of the record, and that
 * the CRDT refused them.
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
} from '@kamiazya/whiteboard-ports'
import { isStoredDocumentUnreadableError } from '@kamiazya/whiteboard-ports'
import { LoroDoc } from 'loro-crdt'
import { expect, it } from 'vitest'
import { DocumentStoreWorkspaceDocs } from './document-store-workspace-docs.js'

/**
 * A store that answers a manifest and chunks which AGREE with each other —
 * so nothing before the import can refuse them — over bytes that are not a
 * loro snapshot. That is the shape a half-written or bit-rotted record has,
 * and the only thing left to notice it is the CRDT.
 */
function storeHolding(bytes: Uint8Array<ArrayBuffer>): DocumentStore {
  const chunks: SaveSnapshotInput['chunks'] = [{ index: 0, of: 1, bytes }]
  return {
    async loadSnapshot(_input: LoadSnapshotInput): Promise<LoadSnapshotResult> {
      return {
        manifest: { chunkCount: 1, totalBytes: bytes.byteLength, maxChunkBytes: bytes.byteLength },
        chunks,
        frontier: new Uint8Array(),
      }
    },
    async loadDeltas(_input: LoadDeltasInput): Promise<LoadDeltasResult> {
      return { updates: [], lastSeq: null, generation: 1, frontier: new Uint8Array() }
    },
    async readSnapshotManifest(_i: ReadSnapshotManifestInput): Promise<ReadSnapshotManifestResult> {
      return null
    },
    async readFrontier(_input: ReadFrontierInput): Promise<ReadFrontierResult> {
      return null
    },
    async saveSnapshot(_input: SaveSnapshotInput): Promise<void> {},
    async saveCompactedSnapshot(
      _input: SaveCompactedSnapshotInput,
    ): Promise<SaveCompactedSnapshotResult> {
      return { ok: true, generation: 1 }
    },
    async appendDeltas(_input: AppendDeltasInput): Promise<AppendDeltasResult> {
      return { frontier: new Uint8Array() }
    },
    async deleteDoc(_input: DeleteDocInput): Promise<void> {},
  } as unknown as DocumentStore
}

it('raises a typed unreadable error when the stored snapshot is not a document', async () => {
  const docs = new DocumentStoreWorkspaceDocs(storeHolding(new Uint8Array([1, 2, 3, 4, 5])))

  await expect(docs.open('ws')).rejects.toSatisfy(isStoredDocumentUnreadableError)
})

it('raises the same when a stored DELTA is not importable', async () => {
  // A snapshot that reads and a log entry that does not: the record is still
  // the thing at fault, and the second import is as much part of reading it
  // as the first.
  const sound = new LoroDoc()
  sound.getMap('meta').set('title', 'readable')
  sound.commit()
  const store = storeHolding(new Uint8Array(sound.export({ mode: 'snapshot' })))
  store.loadDeltas = async () => ({
    updates: [new Uint8Array([9, 9, 9])],
    lastSeq: 1,
    generation: 1,
    frontier: new Uint8Array(),
  })

  await expect(docs_open(store)).rejects.toSatisfy(isStoredDocumentUnreadableError)
})

function docs_open(store: DocumentStore): Promise<unknown> {
  return new DocumentStoreWorkspaceDocs(store).open('ws')
}
