/**
 * Which uploaded files a workspace still needs — the one definition every
 * keeper's file collection judges by.
 *
 * A file is needed while anything a user can still reach names it: a live
 * document, a trashed one (a restore brings it back under the same id), or a
 * saved version of either. Each keeper stores those three differently — the
 * daemon in SQLite rows and a blob directory, the browser in IndexedDB — so
 * the I/O arrives as `FileReferenceReads` and the judgement stays here. Two
 * hand-written copies of this walk are how one keeper learns a new place an
 * image can sit and the other deletes it.
 *
 * Fail closed: what cannot be read is reported in `unjudged` rather than
 * read as "names nothing", and a caller that deletes must refuse to while
 * that list is non-empty.
 */

import { LoroDoc } from 'loro-crdt'
import type { DocumentContainers } from './containers.js'
import { collectImageRefIds } from './image-refs.js'
import type { TrashEntry } from './workspace-tree.js'
import {
  documentContainers,
  importWorkspaceSubtree,
  projectWorkspaceDocument,
  readTrashEntries,
  readWorkspaceDocuments,
  unreadableWorkspaceNodes,
} from './workspace-tree.js'

/** A document whose saved versions are asked for. */
export interface FileReferenceHolder {
  readonly documentId: string
  /** Where it is, or where it was when it was trashed. */
  readonly path: string
  readonly trashed: boolean
}

/** Something the scan had to judge and could not read. Not a stored shape. */
export type UnjudgedFileHolder =
  | { kind: 'unreadable-node'; treeId: string }
  | { kind: 'trash'; documentId: string; cause: unknown }
  | { kind: 'version'; documentId: string; path: string; versionId: string; cause: unknown }

export interface FileReferenceReads {
  /** The evacuated bytes a trash entry names, or null when they are gone. */
  trashBytes(entry: TrashEntry): Promise<Uint8Array | null>
  /** A keeper's saved versions. Absent, no version is walked. */
  readonly versions?: {
    list(holder: FileReferenceHolder): Promise<readonly string[]>
    /** One version's state of the holder; null is as unreadable as a throw. */
    load(holder: FileReferenceHolder, versionId: string): Promise<DocumentContainers | null>
  }
  /**
   * Awaited before each unit read — a trash entry, a live document, a
   * version. Every read is a synchronous WASM call, so a keeper whose loop
   * serves requests yields here; one that does not can omit it.
   */
  between?(): Promise<void>
}

export interface FileReferenceScan {
  readonly referenced: Set<string>
  readonly unjudged: readonly UnjudgedFileHolder[]
}

/** What a trash entry's evacuated bytes hold, or null when the bytes are gone. */
async function trashedContent(
  entry: TrashEntry,
  reads: FileReferenceReads,
): Promise<DocumentContainers | null> {
  const bytes = await reads.trashBytes(entry)
  if (bytes === null) return null
  const scratch = new LoroDoc()
  if (importWorkspaceSubtree(scratch, bytes) === null) {
    throw new Error('trash bytes hold no document')
  }
  const content = projectWorkspaceDocument(scratch, entry.documentId)
  if (content === null) throw new Error('trash bytes hold a different document')
  return content
}

async function versionContent(
  versions: NonNullable<FileReferenceReads['versions']>,
  holder: FileReferenceHolder,
  versionId: string,
): Promise<DocumentContainers> {
  const past = await versions.load(holder, versionId)
  if (past === null) throw new Error('a listed version could not be loaded')
  return past
}

/** What one pass accumulates; each arm below adds to it. */
interface ScanState {
  readonly referenced: Set<string>
  readonly unjudged: UnjudgedFileHolder[]
  /** The documents whose versions are asked for once the documents are read. */
  readonly holders: FileReferenceHolder[]
  readonly between: () => Promise<void>
}

function collect(state: ScanState, doc: DocumentContainers): void {
  for (const id of collectImageRefIds(doc)) state.referenced.add(id)
}

async function scanTrash(record: LoroDoc, reads: FileReferenceReads, state: ScanState) {
  for (const entry of readTrashEntries(record)) {
    await state.between()
    try {
      // Bytes that are gone leave nothing a restore could bring back, so
      // there is nothing for the entry's images to be kept for.
      const content = await trashedContent(entry, reads)
      if (content === null) continue
      collect(state, content)
      state.holders.push({ documentId: entry.documentId, path: entry.path, trashed: true })
    } catch (cause) {
      state.unjudged.push({ kind: 'trash', documentId: entry.documentId, cause })
    }
  }
}

/**
 * Every document by id, the shadowed ones included: a path names only the
 * first document carrying it, and the second one's images are as live.
 */
async function scanLive(record: LoroDoc, state: ScanState) {
  for (const entry of readWorkspaceDocuments(record)) {
    await state.between()
    collect(state, documentContainers(record, entry.documentId))
    state.holders.push({ documentId: entry.documentId, path: entry.path, trashed: false })
  }
}

async function scanVersions(
  versions: NonNullable<FileReferenceReads['versions']>,
  state: ScanState,
) {
  for (const holder of state.holders) {
    for (const versionId of await versions.list(holder)) {
      await state.between()
      try {
        collect(state, await versionContent(versions, holder, versionId))
      } catch (cause) {
        const { documentId, path } = holder
        state.unjudged.push({ kind: 'version', documentId, path, versionId, cause })
      }
    }
  }
}

export async function scanFileReferences(
  record: LoroDoc,
  reads: FileReferenceReads,
): Promise<FileReferenceScan> {
  const state: ScanState = {
    referenced: new Set(),
    // A node this build cannot read is absent from the document listing, and
    // so are its documents' images.
    unjudged: unreadableWorkspaceNodes(record).map((treeId) => ({
      kind: 'unreadable-node',
      treeId,
    })),
    holders: [],
    between: reads.between ?? (async () => {}),
  }
  await scanTrash(record, reads, state)
  await scanLive(record, state)
  if (reads.versions !== undefined) await scanVersions(reads.versions, state)
  return { referenced: state.referenced, unjudged: state.unjudged }
}
