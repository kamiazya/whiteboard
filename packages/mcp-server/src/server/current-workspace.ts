import { generateDocumentId } from '@kamiazya/whiteboard-model'
import { DocumentStoreWorkspaceDocs } from '@kamiazya/whiteboard-workspace-index'
import { getDb } from './store/db/index.js'
import { prepareDataDir } from './store/db/prepare.js'
import { upsertWorkspaceRow } from './store/db/upsert-workspace.js'
import { LibsqlDocumentStore } from './store/libsql/libsql-document-store.js'

// The current workspace id is the live source of truth in the `runtime`
// table. ensureWorkspaceId memoizes the lookup per dataDir; the first caller
// pays for migrations and the row read, later callers share the promise.
const ensureCache = new Map<string, Promise<string>>()

async function resolveWorkspaceId(db: Awaited<ReturnType<typeof getDb>>): Promise<string> {
  const row = await db
    .selectFrom('runtime')
    .select(['value'])
    .where('key', '=', 'currentWorkspaceId')
    .executeTakeFirst()
  if (row?.value) return row.value

  // Fresh install — no row yet. Pick a new id and upsert atomically so
  // concurrent ensureWorkspaceId callers across worker threads cannot
  // diverge on the chosen id.
  //
  // A canonical ULID, which is what ADR-0019 makes a workspace id and what
  // migration `0019` re-keyed every workspace a daemon already held to. This
  // is the writer on the OTHER side of that migration: while it minted
  // nanoids, the migration corrected the data and the producer went on
  // writing the old shape, so a daemon created after 0019 shipped was never
  // re-keyed by anything.
  //
  // The bootstrapped workspace has no segment, so its handle IS this id and
  // it is what the address shows. It also has to stay out of the namespace
  // segments occupy: segment-first resolution is unambiguous only because a
  // segment may not be ULID-shaped, and a nanoid is not ULID-shaped either.
  //
  // `generateDocumentId` despite the name — ADR-0019 gave both ids the same
  // canonical shape deliberately, and the confusion guard is the pair of
  // distinct Zod schemas, not a second generator.
  const id = generateDocumentId()
  const now = Date.now()
  await db
    .insertInto('runtime')
    .values({ key: 'currentWorkspaceId', value: id, updatedAt: now })
    .onConflict((oc) => oc.column('key').doUpdateSet({ updatedAt: now }))
    .execute()
  // The conflict path leaves the existing value in place, so read it back
  // to return whichever id won the race.
  const settled = await db
    .selectFrom('runtime')
    .select(['value'])
    .where('key', '=', 'currentWorkspaceId')
    .executeTakeFirst()
  return settled?.value ?? id
}

export function ensureWorkspaceId(dataDir: string): Promise<string> {
  const existing = ensureCache.get(dataDir)
  if (existing) return existing
  const pending = (async () => {
    await prepareDataDir(dataDir)
    const db = await getDb(dataDir)

    const resolved = await resolveWorkspaceId(db)
    // Materialize the workspace, not only its registry row: the list answers
    // from the row, and every addressed route from the stored record, so a
    // row alone is a workspace the list names and the document index refuses
    // as not found — the first screen a browser meets on a fresh daemon.
    // Both halves are idempotent, and the record check also repairs a daemon
    // an earlier bootstrap left with the row and no record.
    const docs = new DocumentStoreWorkspaceDocs(new LibsqlDocumentStore(db))
    if ((await docs.open(resolved)) === null) await docs.save(resolved, await docs.create(resolved))
    await upsertWorkspaceRow(db, resolved)
    return resolved
  })()
  ensureCache.set(dataDir, pending)
  pending.catch(() => {
    if (ensureCache.get(dataDir) === pending) {
      ensureCache.delete(dataDir)
    }
  })
  return pending
}

export function clearWorkspaceIdCache(): void {
  ensureCache.clear()
}
