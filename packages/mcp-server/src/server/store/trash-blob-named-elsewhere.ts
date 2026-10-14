import { readTrashEntries } from '@kamiazya/whiteboard-loro-adapter'
import { blobRefKey } from '@kamiazya/whiteboard-ports'
import {
  DocumentStoreWorkspaceDocs,
  type TrashBlobNamedElsewhere,
} from '@kamiazya/whiteboard-workspace-index'
import { getLogger } from '../log.js'
import { documentStoreReady } from './store-handles.js'
import type { StoreScope } from './store-scope.js'

const log = getLogger('trash-blob-named-elsewhere')

/**
 * The daemon's answer to "does another workspace's trash still name this
 * blob?" — over every workspace the scope's registry holds, because the
 * daemon's blob store is one per tenant, keyed by digest alone, and so
 * shared by every workspace in it.
 *
 * Each record is read from the store rather than through the workspace-doc
 * cache: the cache would keep every neighbour resident after one purge, and
 * following a cached record that is behind takes THAT workspace's write lock
 * while the caller holds its own — two purges in two workspaces would each
 * wait on the other.
 *
 * A record that cannot be read answers "named": keeping a blob costs space
 * a later purge can reclaim, deleting one a row still names costs a document.
 */
export function trashBlobNamedElsewhere(scope: StoreScope): TrashBlobNamedElsewhere {
  return async ({ workspaceId, ref }) => {
    const db = await scope.db()
    const rows = await db.selectFrom('workspaces').select('id').orderBy('id').execute()
    const docs = new DocumentStoreWorkspaceDocs(await documentStoreReady(scope))
    const key = blobRefKey(ref)
    // Sequential: one decoded record resident at a time, and the first hit ends the walk.
    for (const { id } of rows) {
      if (id === workspaceId) continue
      let record: Awaited<ReturnType<DocumentStoreWorkspaceDocs['open']>>
      try {
        record = await docs.open(id)
      } catch (err) {
        log.warning(
          { workspaceId: id, err },
          'kept a trash blob: a workspace record would not open',
        )
        return true
      }
      if (record === null) continue
      if (readTrashEntries(record).some((row) => blobRefKey(row.blob) === key)) return true
    }
    return false
  }
}
