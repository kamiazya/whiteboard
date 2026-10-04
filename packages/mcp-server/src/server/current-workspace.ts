import { DAEMON_DEFAULT_SEGMENT } from '@kamiazya/whiteboard-daemon-client/api-contracts/document'
import { generateDocumentId } from '@kamiazya/whiteboard-model'
import { DocumentStoreWorkspaceDocs } from '@kamiazya/whiteboard-workspace-index'
import { getLogger } from './log.js'
import { claimWorkspaceSegment } from './store/db/claim-workspace-segment.js'
import { getDb } from './store/db/index.js'
import { prepareDataDir } from './store/db/prepare.js'
import { upsertWorkspaceRow } from './store/db/upsert-workspace.js'
import { LibsqlDocumentStore } from './store/libsql/libsql-document-store.js'

// The current workspace id is the live source of truth in the `runtime`
// table. ensureWorkspaceId memoizes the lookup per dataDir; the first caller
// pays for migrations and the row read, later callers share the promise.
//
// The bootstrapped workspace is the one holding the segment `default`: it is
// what an agent addresses before it has been told any id, and the first
// workspace a browser opens. Claiming it here, rather than leaving the first
// `createWorkspace: true` to mint it, is what keeps that call from creating a
// second workspace beside an empty bootstrapped one.
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
  // The id has to stay out of the namespace segments occupy: segment-first
  // resolution is unambiguous only because a segment may not be ULID-shaped,
  // and a nanoid is not ULID-shaped either. The segment `default` is claimed
  // for this workspace separately, by `ensureWorkspaceId`.
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
    // Every boot, not only the first: a daemon that bootstrapped before this
    // existed has the workspace without a segment. A workspace that already
    // has one, or a segment another workspace already holds, is left alone.
    if (await claimWorkspaceSegment(db, resolved, DAEMON_DEFAULT_SEGMENT)) {
      getLogger('current-workspace').info(
        { workspaceId: resolved, segment: DAEMON_DEFAULT_SEGMENT },
        'gave the current workspace its default segment',
      )
    }
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

export function clearWorkspaceIdCacheForTests(): void {
  ensureCache.clear()
}
