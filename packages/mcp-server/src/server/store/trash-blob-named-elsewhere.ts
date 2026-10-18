import { readTrashEntries } from '@kamiazya/whiteboard-loro-adapter'
import { blobRefKey, type DocumentStore } from '@kamiazya/whiteboard-ports'
import {
  DocumentStoreWorkspaceDocs,
  type TrashBlobNamedElsewhere,
} from '@kamiazya/whiteboard-workspace-index'
import { getLogger } from '../log.js'
import { documentStoreReady } from './store-handles.js'
import type { StoreScope } from './store-scope.js'

const log = getLogger('trash-blob-named-elsewhere')

/**
 * The trash digests one stored record named, and the position the record
 * stood at when it was read. Reused only while the store still reports that
 * same position, so a record is decoded again exactly when it has changed.
 */
interface NamedDigests {
  readonly position: string
  readonly digests: ReadonlySet<string>
}

/**
 * Least recently used first (Map order), and bounded by the digests held in
 * total rather than by records, since one record's trash can name any number
 * of blobs. A record naming more than the whole budget is answered from its
 * decode and never kept: holding it would evict every other record for one.
 *
 * 65536 digests is a few MB of strings — a tenant's every trash row many
 * times over at ordinary sizes — and a miss costs one decode, which is what
 * the call cost before anything was remembered.
 */
const namedDigestsByRecord = new Map<string, NamedDigests>()
const DEFAULT_NAMED_DIGESTS_BUDGET = 65_536
let namedDigestsBudget = DEFAULT_NAMED_DIGESTS_BUDGET
let namedDigestsHeld = 0

/** Test-only: shrink the budget so the bound is reachable; answers the restore. */
export function _setNamedDigestsBudgetForTests(budget: number): () => void {
  forgetAll()
  namedDigestsBudget = budget
  return () => {
    forgetAll()
    namedDigestsBudget = DEFAULT_NAMED_DIGESTS_BUDGET
  }
}

/** Test-only: how many digests are remembered across every record. */
export function _namedDigestsHeldForTests(): number {
  return namedDigestsHeld
}

function forgetAll(): void {
  namedDigestsByRecord.clear()
  namedDigestsHeld = 0
}

function forget(cacheKey: string): void {
  const known = namedDigestsByRecord.get(cacheKey)
  if (known === undefined) return
  namedDigestsByRecord.delete(cacheKey)
  namedDigestsHeld -= known.digests.size
}

function recall(cacheKey: string, position: string): ReadonlySet<string> | undefined {
  const known = namedDigestsByRecord.get(cacheKey)
  if (known?.position !== position) return undefined
  // Reinserted so Map order stays recency order.
  namedDigestsByRecord.delete(cacheKey)
  namedDigestsByRecord.set(cacheKey, known)
  return known.digests
}

function remember(cacheKey: string, entry: NamedDigests): void {
  forget(cacheKey)
  if (entry.digests.size > namedDigestsBudget) return
  for (const oldest of namedDigestsByRecord.keys()) {
    if (namedDigestsHeld + entry.digests.size <= namedDigestsBudget) break
    forget(oldest)
  }
  namedDigestsByRecord.set(cacheKey, entry)
  namedDigestsHeld += entry.digests.size
}

function recordKey(scope: StoreScope, workspaceId: string): string {
  return `${scope.dataDir}::${scope.layout.tenantId}::${workspaceId}`
}

/**
 * Where the stored record stands, as one string that changes on every write.
 *
 * Every append raises `lastSeq` within a generation and every fold raises the
 * generation, so the pair moves on any change while the record lives. A
 * record deleted and minted again restarts at generation 1 and could repeat a
 * pair; the frontier is beside it so a re-minted record must also carry the
 * same version vector — the same op ids — to be mistaken for the old one.
 * `null` is a record with no snapshot, which `open` answers as absent.
 */
async function storedPosition(store: DocumentStore, workspaceId: string): Promise<string | null> {
  const docRef = { kind: 'workspace-tree', workspaceId } as const
  // Past the end: the position and no bytes, all three in one transaction.
  const { lastSeq, generation, frontier } = await store.loadDeltas({
    docRef,
    afterSeq: Number.MAX_SAFE_INTEGER,
  })
  if (generation === null) return null
  return `${generation}:${lastSeq}:${Buffer.from(frontier).toString('hex')}`
}

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
 * What a record named is kept beside its stored position, and a record is
 * decoded only when that position has moved. Decoding every record on every
 * call let one member's purge loop in their own workspace decode every other
 * member's record each time, at the cost of the whole tenant's data. The
 * position is read from the STORE on every call rather than maintained by the
 * writers, so no write path — another instance's included — can leave it
 * claiming a record that no longer holds.
 *
 * A record that cannot be read answers "named", and nothing is remembered for
 * it: keeping a blob costs space a later purge can reclaim, deleting one a row
 * still names costs a document.
 */
export function trashBlobNamedElsewhere(scope: StoreScope): TrashBlobNamedElsewhere {
  return async ({ workspaceId, ref }) => {
    const db = await scope.db()
    const rows = await db.selectFrom('workspaces').select('id').orderBy('id').execute()
    forgetUnregistered(scope, new Set(rows.map((row) => row.id)))
    const store = await documentStoreReady(scope)
    const docs = new DocumentStoreWorkspaceDocs(store)
    const key = blobRefKey(ref)
    // Sequential: one decoded record resident at a time, and the first hit ends the walk.
    for (const { id } of rows) {
      if (id === workspaceId) continue
      let digests: ReadonlySet<string> | null
      try {
        digests = await namedBy(scope, store, docs, id)
      } catch (err) {
        forget(recordKey(scope, id))
        log.warning(
          { workspaceId: id, err },
          'kept a trash blob: a workspace record would not open',
        )
        return true
      }
      if (digests?.has(key) === true) return true
    }
    return false
  }
}

async function namedBy(
  scope: StoreScope,
  store: DocumentStore,
  docs: DocumentStoreWorkspaceDocs,
  workspaceId: string,
): Promise<ReadonlySet<string> | null> {
  const cacheKey = recordKey(scope, workspaceId)
  // Read BEFORE the decode: a write landing between the two leaves a newer
  // record filed under an older position, which the next call reads as moved.
  const position = await storedPosition(store, workspaceId)
  if (position === null) {
    forget(cacheKey)
    return null
  }
  const known = recall(cacheKey, position)
  if (known !== undefined) return known
  const record = await docs.open(workspaceId)
  if (record === null) {
    forget(cacheKey)
    return null
  }
  const digests = new Set(readTrashEntries(record).map((row) => blobRefKey(row.blob)))
  remember(cacheKey, { position, digests })
  return digests
}

/** Drops what is remembered for a workspace the registry no longer holds. */
function forgetUnregistered(scope: StoreScope, registered: ReadonlySet<string>): void {
  const prefix = recordKey(scope, '')
  for (const cacheKey of namedDigestsByRecord.keys()) {
    if (cacheKey.startsWith(prefix) && !registered.has(cacheKey.slice(prefix.length))) {
      forget(cacheKey)
    }
  }
}
