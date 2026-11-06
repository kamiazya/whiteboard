import { type DocumentKind, generateDocumentId } from '@kamiazya/whiteboard-model'
import { type DocumentEntry, documentEntrySchema } from '@kamiazya/whiteboard-ports'
import { DOCUMENT_INDEX_STORE, WORKSPACES_STORE } from '../lib/browser-idb.js'
import { inTransaction, request } from '../lib/idb-tx.js'

export interface LegacyRowInput {
  readonly workspaceId: string
  readonly path: string
  readonly kind?: DocumentKind
  readonly name?: string
  /** Minted when absent, as the old create path minted it. */
  readonly documentId?: string
}

/**
 * Writes one per-document index row — the shape builds before the workspace
 * tree wrote — straight into its store, so a test can prove the browser
 * keeper REFUSES a workspace holding one rather than reading it as empty.
 *
 * Directly, because no production path writes one any more. The workspace's
 * registry row is written too when it is absent — bare, and never over an
 * existing one — because every browser that holds such a row also holds its
 * workspace. `add`, not `put`, for the row itself, so seeding a path twice
 * fails rather than replacing the first row behind a test's back.
 */
export async function seedLegacyRow(
  input: LegacyRowInput,
  dbName?: string,
): Promise<DocumentEntry> {
  const entry = documentEntrySchema.parse({
    documentId: input.documentId ?? generateDocumentId(),
    path: input.path,
    ...(input.kind === undefined ? {} : { kind: input.kind }),
    ...(input.name === undefined ? {} : { name: input.name }),
  })
  await inTransaction(dbName, [WORKSPACES_STORE, DOCUMENT_INDEX_STORE], 'readwrite', async (tx) => {
    const workspaces = tx.objectStore(WORKSPACES_STORE)
    if ((await request(workspaces.getKey(input.workspaceId))) === undefined) {
      await request(workspaces.add({ workspaceId: input.workspaceId }, input.workspaceId))
    }
    await request(
      tx.objectStore(DOCUMENT_INDEX_STORE).add({ ...entry, workspaceId: input.workspaceId }),
    )
  })
  return entry
}
