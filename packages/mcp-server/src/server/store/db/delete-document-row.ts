import { DocumentHasDescendantsError, findDescendantPath } from '@kamiazya/whiteboard-ports'

import type { Database } from './index.js'

/**
 * The one implementation of "remove a document's row", reached through
 * `SqliteDocumentIndex.deleteDocument` (`deps.documentIndex`).
 *
 * It was extracted when the HTTP delete and `wb_document_delete` were two
 * sequences that each held a copy of this refusal rule — two chances for
 * them to stop agreeing about what a delete refuses. The HTTP route is now
 * an adapter over the operation, so there is one caller again; the rule
 * stays here rather than back inside the index because that is where the
 * index's own contract says it belongs.
 *
 * Refusing on descendants rather than cascading is the DocumentIndex
 * contract: a cascade is reachable from one call naming one path, and
 * deletion has nothing to undo it.
 *
 * `branches`/`versions` rows do NOT go with it: migration 0016 dropped the
 * cascade FK, so the caller's teardown deletes them explicitly after this
 * returns (documentTeardown's bracket). Anything filed under a VERSION id —
 * a thumbnail — still becomes unreachable once those rows go, which is why
 * document teardown collects what it needs before calling here.
 *
 * Callers hold the workspace write lock. It is re-entrant per async chain,
 * so taking it again around this is safe and is what both callers do.
 */
export async function deleteDocumentRow(
  db: Database,
  workspaceId: string,
  path: string,
): Promise<void> {
  const rows = await db
    .selectFrom('documents')
    .select(['id', 'path'])
    .where('workspaceId', '=', workspaceId)
    .execute()
  const descendant = findDescendantPath(rows, path)
  if (descendant !== undefined) {
    throw new DocumentHasDescendantsError(
      path,
      `Delete "${descendant}" and any others below it first.`,
    )
  }
  await db
    .deleteFrom('documents')
    .where('workspaceId', '=', workspaceId)
    .where('path', '=', path)
    .execute()
}
