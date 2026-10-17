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
  abstract readonly status: 400 | 413
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
