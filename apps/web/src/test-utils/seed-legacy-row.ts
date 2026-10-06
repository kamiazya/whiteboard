import { type DocumentKind, generateDocumentId } from '@kamiazya/whiteboard-model'
import { type DocumentEntry, documentEntrySchema } from '@kamiazya/whiteboard-ports'
import { InMemoryDocumentIndex } from '@kamiazya/whiteboard-ports/test-utils'
import { DOCUMENT_INDEX_STORE, WORKSPACES_STORE } from '../lib/browser-idb.js'
import { resolveBrowserWorkspaceId } from '../lib/browser-workspace-id.js'
import { IdbDocumentIndex } from '../lib/idb-document-index.js'
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
 * Writes one legacy per-document index row — the shape older builds wrote
 * and the startup fold reads and retires — straight into its store.
 *
 * Directly, because no production path writes one any more: a document this
 * build creates lives in the workspace tree. A test about the fold, a
 * migration or the stored shape still needs the row, so it is written here
 * in the shape `IdbDocumentIndex.listDocuments` hydrates.
 *
 * The workspace's registry row is written too when it is absent — bare, and
 * never over an existing one — because every browser that holds a legacy row
 * also holds its workspace, and the fold lists rows through a read that
 * refuses an unknown workspace. `add`, not `put`, for the row itself, so
 * seeding a path twice fails rather than replacing the first row behind a
 * test's back.
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

/**
 * Whether a legacy row still names `documentId`, read through the same
 * listing the fold reads rows with — so "retired" here means retired to the
 * fold too.
 */
export async function hasLegacyRow(
  { workspaceId, documentId }: { readonly workspaceId: string; readonly documentId: string },
  dbName?: string,
): Promise<boolean> {
  const rows = await new IdbDocumentIndex(dbName).listDocuments({ workspaceId })
  return rows.some((row) => row.documentId === documentId)
}

/**
 * The browser workspace's legacy rows, read through the listing the startup
 * fold reads them with and held as a port-shaped index — for the summary
 * layer, which takes a `DocumentIndex`, while the row store is not one.
 * Resolves the workspace id first, as the boot chain does, and is a snapshot:
 * read again for each answer that has to be current.
 */
export async function legacyRowsOfBrowserWorkspace(
  dbName?: string,
): Promise<InMemoryDocumentIndex> {
  const workspaceId = await resolveBrowserWorkspaceId(dbName)
  const index = new InMemoryDocumentIndex()
  index.seedWorkspace({ workspaceId })
  const rows = await new IdbDocumentIndex(dbName).listDocuments({ workspaceId })
  for (const row of rows) index.seed({ ...row, workspaceId })
  return index
}
