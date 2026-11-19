import {
  type SyncWriteRefusalCode,
  WORKSPACE_MAX_DOCUMENTS,
  WORKSPACE_MAX_FOLDERS,
} from '@kamiazya/whiteboard-model'

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
