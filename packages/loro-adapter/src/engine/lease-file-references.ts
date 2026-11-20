/**
 * Which uploaded files a workspace record still names, for a host that holds
 * the record as an engine lease: the same walk as `scanFileReferences`, with
 * each answer read from the engine rather than from a `LoroDoc`.
 */
import { bytesToBase64 } from '@kamiazya/whiteboard-model'
import { z } from 'zod'
import {
  type FileReferenceHolder,
  type FileReferenceScan,
  type FileReferenceSource,
  walkFileReferences,
} from '../file-references.js'
import type { TrashEntry } from '../workspace-trash.js'
import type { WorkspaceDocumentEntry } from '../workspace-tree.js'
import { ownedLease, type RecordLease, read, withLease } from './lease.js'
import { randomPeerId } from './peer.js'

export interface LeaseFileReferenceReads {
  /** The evacuated bytes a trash entry names, or null when they are gone. */
  trashBytes(entry: TrashEntry): Promise<Uint8Array | null>
  /** A keeper's saved versions. Absent, no version is walked. */
  readonly versions?: {
    list(holder: FileReferenceHolder): Promise<readonly string[]>
    /** The images one version's state of the holder names; null is as unreadable as a throw. */
    imageRefIds(holder: FileReferenceHolder, versionId: string): Promise<readonly string[] | null>
  }
  /** Awaited before each unit read, so a host whose loop serves requests can yield. */
  between?(): Promise<void>
}

const idList = z.array(z.string())
// The readers are total over these shapes; the parse asserts the type only.
const trashShape = z.custom<TrashEntry[]>()
const documentsShape = z.custom<WorkspaceDocumentEntry[]>()

const imageRefIdsOf = (record: RecordLease, documentId: string) =>
  read(record, { query: 'imageRefIds', args: { documentId } }, idList)

/**
 * The images a trash entry's evacuated bytes name. The bytes are a record
 * holding the document, placed into a scratch document that is released
 * whatever the read does.
 */
async function trashedImageRefIds(
  record: RecordLease,
  entry: TrashEntry,
  bytes: Uint8Array,
): Promise<readonly string[]> {
  const { engine } = record
  const scratch = ownedLease(engine, engine.open({ peer: randomPeerId() }).handle)
  return withLease(scratch, async (held) => {
    const placed = engine.importSubtree({
      handle: held.handle,
      bytes: bytesToBase64(bytes),
      judge: 'none',
    })
    if (placed.outcome !== 'applied' || placed.root === undefined) {
      throw new Error('trash bytes hold no document')
    }
    if (placed.root.documentId !== entry.documentId) {
      throw new Error('trash bytes hold a different document')
    }
    return imageRefIdsOf(held, entry.documentId)
  })
}

/** The images the record names, as `scanFileReferences` judges them. */
export function scanFileReferencesOfLease(
  record: RecordLease,
  reads: LeaseFileReferenceReads,
): Promise<FileReferenceScan> {
  const { versions } = reads
  const source: FileReferenceSource = {
    unreadableNodes: () => read(record, { query: 'unreadableNodes' }, idList),
    trashEntries: () => read(record, { query: 'trash' }, trashShape),
    liveDocuments: () => read(record, { query: 'documents' }, documentsShape),
    liveImageRefIds: (documentId) => imageRefIdsOf(record, documentId),
    trashBytes: (entry) => reads.trashBytes(entry),
    trashedImageRefIds: (entry, bytes) => trashedImageRefIds(record, entry, bytes),
    ...(versions === undefined
      ? {}
      : {
          versions: {
            list: (holder) => versions.list(holder),
            imageRefIds: async (holder, versionId) => {
              const ids = await versions.imageRefIds(holder, versionId)
              if (ids === null) throw new Error('a listed version could not be loaded')
              return ids
            },
          },
        }),
    between: () => reads.between?.() ?? Promise.resolve(),
  }
  return walkFileReferences(source)
}
