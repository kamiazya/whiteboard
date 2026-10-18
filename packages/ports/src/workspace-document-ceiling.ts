import type { SyncWriteRefusalCode } from '@kamiazya/whiteboard-model'

/**
 * A write the keeper refused for what it would do to the workspace record.
 * Nothing of the write was kept. The code and status are the class's own, so
 * a refusal cannot exist without the answer every surface gives it.
 *
 * Declared here rather than beside the sync operations because one of its
 * refusals, `TooManyDocumentsError`, is raised by the document index too,
 * which sits below server-core.
 */
export abstract class SyncWriteRefusalError extends Error {
  abstract readonly code: SyncWriteRefusalCode
  abstract readonly status: 400 | 409 | 413
}

/**
 * The most documents a workspace record held by this keeper may list. A
 * browser keeper refuses to grow past 2000 documents on any device (ADR-0044's
 * 2026-09-28 addendum), so a record the editor produced never arrives larger.
 * Counted in documents because that is the axis the cost follows — the
 * record's memory is super-linear in document count, and each edited document
 * takes a checkpoint — while the body ceilings already bound the bytes.
 *
 * One number for every way documents arrive, held at each: the sync update of
 * the workspace record (`placementRefusal`) and a promote judge the record
 * they would leave, and every place that mints ONE new document — the index's
 * create, duplicate and trash restore, and the daemon's per-document save of a
 * path the tree does not hold — asks `refuseNewDocuments` first.
 */
export const WORKSPACE_MAX_DOCUMENTS = 2000

/**
 * A write refused because it would leave the workspace record listing more
 * than `WORKSPACE_MAX_DOCUMENTS` documents, and more than it listed before —
 * so a record already past the bound still takes an edit that adds none, and
 * deleting is how it shrinks. Nothing of the write was kept.
 */
export class TooManyDocumentsError extends SyncWriteRefusalError {
  readonly code = 'too_many_documents'
  readonly status = 413

  constructor(public readonly documents: number) {
    super(
      `This write would leave the workspace holding ${documents} documents; a workspace holds at most ${WORKSPACE_MAX_DOCUMENTS}. Move some documents to another workspace first`,
    )
    this.name = 'TooManyDocumentsError'
  }
}

/**
 * Throws `TooManyDocumentsError` when a workspace holding `held` documents
 * would pass the ceiling by taking `adding` more. Asked BEFORE the record is
 * touched, so a refusal leaves nothing to undo.
 */
export function refuseNewDocuments(held: number, adding = 1): void {
  if (adding > 0 && held + adding > WORKSPACE_MAX_DOCUMENTS) {
    throw new TooManyDocumentsError(held + adding)
  }
}

/**
 * The most FOLDERS — nodes holding a path component and no document — a
 * workspace record held by this keeper may list. Every listing walks every
 * node, and a folder costs a listing what a document does (measured: about
 * 22 µs a node, so 10000 folders add about 215 ms to every listing and 50000
 * over a second), while a client mints folders as freely as documents and a
 * path holds at most `DOCUMENT_PATH_MAX_LENGTH / 2` of them.
 *
 * Twice the document ceiling: room for every document to sit in a folder of
 * its own two levels deep. A separate ceiling rather than a share of the
 * document one, because a folder exists only to hold documents — counting it
 * as one would refuse a workspace of 2000 documents for being organised.
 */
export const WORKSPACE_MAX_FOLDERS = 2 * WORKSPACE_MAX_DOCUMENTS

/**
 * A write refused because it would leave the workspace record listing more
 * than `WORKSPACE_MAX_FOLDERS` folders, and more than it listed before. As
 * with documents, a record already past the bound still takes a write that
 * adds none. Nothing of the write was kept.
 */
export class TooManyFoldersError extends SyncWriteRefusalError {
  readonly code = 'too_many_folders'
  readonly status = 413

  constructor(public readonly folders: number) {
    super(
      `This write would leave the workspace holding ${folders} folders; a workspace holds at most ${WORKSPACE_MAX_FOLDERS}. Move or delete some folders' documents first`,
    )
    this.name = 'TooManyFoldersError'
  }
}

/**
 * Throws `TooManyFoldersError` when a workspace holding `held` folders would
 * pass the ceiling by taking `adding` more. Asked before the record is
 * touched, as `refuseNewDocuments` is.
 */
export function refuseNewFolders(held: number, adding: number): void {
  if (adding > 0 && held + adding > WORKSPACE_MAX_FOLDERS) {
    throw new TooManyFoldersError(held + adding)
  }
}

/** What the folder count reads of a workspace record's nodes. */
export interface PlacedNode {
  readonly type: string
  readonly path: string
}

/**
 * How many folders placing something at `path` would create: one for each
 * ancestor no node holds yet, since an existing node of either kind is reused
 * as the parent.
 */
export function foldersMissingFor(nodes: readonly PlacedNode[], path: string): number {
  const held = new Set(nodes.map((node) => node.path))
  const segments = path.split('/')
  let missing = 0
  for (let depth = 1; depth < segments.length; depth++) {
    if (!held.has(segments.slice(0, depth).join('/'))) missing += 1
  }
  return missing
}

/**
 * `refuseNewFolders` for one placement at `path` into a record holding
 * `nodes`, counted the same way for every keeper that creates a path's
 * missing folders as it places a document.
 */
export function refuseNewFoldersAt(nodes: readonly PlacedNode[], path: string): void {
  refuseNewFolders(foldersIn(nodes), foldersMissingFor(nodes, path))
}

/** How many folders a workspace record's `nodes` hold. */
export function foldersIn(nodes: readonly PlacedNode[]): number {
  return nodes.filter((node) => node.type === 'folder').length
}
