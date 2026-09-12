/**
 * The steps `openWhiteboardDb`'s `onupgradeneeded` runs, one per thing a
 * version bump has to do to data already on disk.
 *
 * Separated from the opener because they are the bulk of it and each carries
 * the account of a defect it exists to avoid — but NOT from `DB_VERSION`,
 * which stays with the opener beside the version log. That pairing is the
 * invariant `browser-idb.ts`'s header protects: two openers disagreeing about
 * a version is the failure this module set exists to make impossible, and a
 * step is only ever reached THROUGH the opener.
 *
 * Several are exported for tests rather than for callers. An upgrade step has
 * to be driven inside a genuine `versionchange` transaction to mean anything,
 * and `browser-idb-migration.browser.test.tsx` does exactly that — a
 * re-implementation of the step in the test would assert against itself.
 */
import { generateDocumentId } from '@kamiazya/whiteboard-model'
import { chunkSnapshot } from '@kamiazya/whiteboard-ports'
import {
  CONTENT_TIMESTAMPS_STORE,
  DOCUMENT_INDEX_STORE,
  SYNC_DOCUMENTS_STORE,
  SYNC_SNAPSHOT_CHUNKS_STORE,
  VERSIONS_STORE,
  WORKSPACES_STORE,
} from './browser-idb-stores.js'
import { loroRecordEnvelopeSchema } from './loro-record-envelope.js'

/**
 * The chunk size the v12 migration writes its carried snapshots with.
 *
 * Frozen here rather than read from `LoroStore`: a migration's numbers are
 * the ones it RAN with, and a later change to what the app chunks at must not
 * retroactively change what an already-migrated record claims about itself.
 */
const LEGACY_MAX_CHUNK_BYTES = 1_000_000

export const RENAMED_STORES: readonly (readonly [from: string, to: string])[] = [
  ['canvases', 'documents'],
  ['loroCanvases', 'loroDocuments'],
  ['canvasFiles', 'documentFiles'],
]

/**
 * Copies every record of `from` into `to`, then deletes `from`.
 *
 * The delete is deferred to the cursor's terminal callback on purpose:
 * `deleteObjectStore` is legal at any point in a versionchange transaction,
 * but calling it while the copy's cursor is still walking would kill the
 * source out from under the requests that have not run yet.
 */
export function copyStoreThenDelete(
  db: IDBDatabase,
  tx: IDBTransaction,
  from: string,
  to: string,
  onDone: () => void,
): void {
  if (!db.objectStoreNames.contains(from)) {
    onDone()
    return
  }
  const source = tx.objectStore(from)
  const target = tx.objectStore(to)
  const cursorReq = source.openCursor()
  cursorReq.onsuccess = () => {
    const cursor = cursorReq.result
    if (!cursor) {
      db.deleteObjectStore(from)
      onDone()
      return
    }
    target.put(stripLegacySceneField(cursor.value), cursor.key)
    cursor.continue()
  }
}

/**
 * Drops the pre-v3 `scene` field a metadata row must not carry. Guarded
 * against a non-object row: a corrupt value would otherwise throw a TypeError
 * out of the `in` check, aborting the upgrade transaction and bricking the DB
 * open.
 */
function stripLegacySceneField(value: unknown): unknown {
  if (typeof value !== 'object' || value === null || !('scene' in value)) return value
  const { scene: _scene, ...metadataOnly } = value as Record<string, unknown>
  return metadataOnly
}

/**
 * True for a row already addressed the way v8 stores one.
 *
 * Written out rather than delegating to `documentSnapshotSchema`: a migration
 * has to keep meaning what it meant on the day it ran, and a live schema is
 * free to gain a required field later, which would silently turn this into a
 * discard of rows it was never meant to touch. Guarded against a non-object
 * value — a corrupt row must not throw out of an upgrade transaction, which
 * would abort it and brick the database open.
 */
function isPathAddressed(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false
  const row = value as Record<string, unknown>
  return (
    typeof row.documentId === 'string' &&
    typeof row.workspaceId === 'string' &&
    typeof row.path === 'string'
  )
}

export function discardPrePathDocuments(tx: IDBTransaction, done: () => void): void {
  const documents = tx.objectStore('documents')
  const loro = tx.objectStore('loroDocuments')
  const meta = tx.objectStore('meta')
  const cursorReq = documents.openCursor()
  cursorReq.onsuccess = () => {
    const cursor = cursorReq.result
    if (!cursor) {
      done()
      return
    }
    if (!isPathAddressed(cursor.value)) {
      const key = cursor.primaryKey
      cursor.delete()
      loro.delete(key)
      // Cleared only when it named THIS row: a blanket clear would log a user
      // out of the documents that survive.
      const pointer = meta.get('defaultDocumentId')
      pointer.onsuccess = () => {
        if (pointer.result === key) meta.delete('defaultDocumentId')
      }
    }
    cursor.continue()
  }
}

/**
 * Copies every surviving `documents` row into the `DocumentIndex` stores, then
 * drops `documents`.
 *
 * The workspace rows come from the documents themselves rather than from a
 * hardcoded `'local'`: this store never held more than one workspace, but
 * reading it from the data is the version that stays correct if it ever did.
 * The literal `'local'` key below is still written unconditionally on every
 * upgrade — `rekeyBrowserWorkspace` (v13->v14, further down) is what absorbs
 * it onto the canonical id the browser UI actually opens.
 */
/**
 * Moves every Loro content record into the `DocumentStore` port's store, and
 * its `updatedAt` into the content-timestamp store, then drops the old one.
 *
 * A copy, not a conversion: the snapshot bytes go across unchanged, wrapped in
 * the manifest `chunkSnapshot` derives for them. That derivation is a pure,
 * SYNCHRONOUS function of the bytes and a chunk size, which is what makes this
 * a migration the upgrade transaction can run at all — an async step (a digest,
 * a fetch) would lose the transaction mid-walk.
 *
 * The delta log travels too. A record that carried one is a document whose
 * snapshot alone is not its current state, so leaving the log behind would
 * silently roll every unsaved edit back.
 */
export function carryLoroDocuments(tx: IDBTransaction, done: () => void): void {
  const loro = tx.objectStore('loroDocuments')
  const sync = tx.objectStore(SYNC_DOCUMENTS_STORE)
  const stamps = tx.objectStore(CONTENT_TIMESTAMPS_STORE)
  const cursorReq = loro.openCursor()
  cursorReq.onsuccess = () => {
    const cursor = cursorReq.result
    if (!cursor) {
      // Only once the walk is done: deleting the store mid-cursor would end
      // the walk with records still uncarried.
      tx.db.deleteObjectStore('loroDocuments')
      done()
      return
    }
    const documentId = String(cursor.primaryKey)
    const parsed = loroRecordEnvelopeSchema.safeParse(cursor.value)
    if (!parsed.success) {
      // Carried VERBATIM rather than skipped. A record this build cannot
      // parse is one written by a newer one, or one that is damaged — and
      // both are things `loadSnapshot` reports as an unreadable document,
      // which is a recoverable answer. Skipping it here would delete it with
      // the store at the end of this walk, turning "your build is old" into
      // "your document is gone" and destroying the bytes on the way.
      sync.put(cursor.value, `document:${documentId}`)
      cursor.continue()
      return
    }
    {
      const { manifest, chunks } = chunkSnapshot(parsed.data.snapshot, LEGACY_MAX_CHUNK_BYTES)
      sync.put(
        {
          v: 1,
          snapshot: { manifest, chunks },
          // Empty, matching what `LoroStore` writes: nothing in the browser
          // reads a frontier, and inventing one on migration would be a value
          // the first real reader has to unpick.
          frontier: new Uint8Array(),
          deltas: parsed.data.deltas ?? [],
        },
        `document:${documentId}`,
      )
      stamps.put(parsed.data.updatedAt, documentId)
    }
    cursor.continue()
  }
}

/**
 * True for a record written under the v12 envelope, whatever else is wrong
 * with it.
 *
 * Deliberately shallower than `syncRecordSchema`: this decides whether a value
 * is THIS migration's to rewrite, and a record whose snapshot is damaged is
 * still one whose envelope has to move forward — leaving it at v1 would change
 * `malformed` into `unsupported-version`, which tells the user the opposite
 * thing about why their document will not open. A record carried across
 * VERBATIM by v12 (one it could not parse either) has no `v: 1` and is left
 * exactly where it is.
 */
function isEnvelopeV1(value: unknown): value is { v: 1; snapshot: unknown } {
  return typeof value === 'object' && value !== null && (value as { v?: unknown }).v === 1
}

/**
 * Moves every v12 record's inline chunks into `syncSnapshotChunks` and bumps
 * the envelope to v2.
 *
 * Ordered AFTER `carryLoroDocuments` rather than beside it, for the reason
 * every carrier in this file is ordered: it walks the store that carrier is
 * still filling, and a cursor opened while those puts are queued sees an empty
 * store, splits nothing, and looks exactly like a successful upgrade — leaving
 * v1 records the new parser reports as unreadable documents.
 */
export function splitInlineSnapshotChunks(tx: IDBTransaction, done: () => void): void {
  const sync = tx.objectStore(SYNC_DOCUMENTS_STORE)
  const chunks = tx.objectStore(SYNC_SNAPSHOT_CHUNKS_STORE)
  const cursorReq = sync.openCursor()
  cursorReq.onsuccess = () => {
    const cursor = cursorReq.result
    if (!cursor) {
      done()
      return
    }
    const record = cursor.value
    if (isEnvelopeV1(record)) {
      const snapshot = record.snapshot as { manifest?: unknown; chunks?: unknown } | null
      const inline = snapshot === null ? undefined : snapshot.chunks
      if (Array.isArray(inline)) {
        for (const chunk of inline) chunks.put(chunk, [cursor.primaryKey, chunk.index])
        cursor.update({ ...record, v: 2, snapshot: { manifest: snapshot?.manifest } })
      } else {
        cursor.update({ ...record, v: 2 })
      }
    }
    cursor.continue()
  }
}

/**
 * The literal key the browser's single workspace lived under before v14.
 * Spelled out rather than imported from anywhere else: this migration's job
 * is to make the string stop meaning anything, and a migration's own text is
 * history that names the shape it found, the way `defaultCanvasId` still
 * does in the v6->v7 rename above.
 */
const LEGACY_BROWSER_WORKSPACE_ID = 'local'

/**
 * Re-keys the browser's one workspace off `'local'` onto a canonical ULID —
 * the registry row, every `documentIndex` row it owns, and the
 * `workspace-tree:local` sync record plus its chunk rows.
 *
 * Convergent, not run-once, because it CANNOT assume it runs exactly once:
 * `backfillDocumentIndex` (v9->v10, above) unconditionally re-puts
 * `{workspaceId:'local'}` under key `'local'` on every future upgrade — it
 * has no way to know this step exists — so a later multi-version jump
 * resurrects the very row this step just deleted, inside the SAME
 * transaction, ordered right before it. The fix is not to skip when a ULID
 * row already exists (that would leave the resurrected `'local'` row behind
 * forever); it is to look for an existing target on every run and absorb
 * whatever `'local'` remnant is present into it, minting a new id only when
 * no target exists yet. Ordered last in the upgrade chain for the reason
 * every carrier here is: it reads what `backfillDocumentIndex` just wrote.
 *
 * Exported (only `browser-idb-migration.browser.test.tsx` imports it): the
 * convergence property this exists for can only be observed by running this
 * step a second time, and `backfillDocumentIndex`'s re-put depends on stores
 * (`documents`, `loroDocuments`) that no longer exist by v14 — replaying the
 * WHOLE upgrade chain a second time throws on those, where a real future
 * migration would still have them. Invoking this one step directly, against
 * a manually re-seeded `'local'` remnant, tests the real convergence logic
 * without needing a real v15 to reach it.
 */
export function rekeyBrowserWorkspace(tx: IDBTransaction, done: () => void): void {
  const workspaces = tx.objectStore(WORKSPACES_STORE)
  const index = tx.objectStore(DOCUMENT_INDEX_STORE)
  const sync = tx.objectStore(SYNC_DOCUMENTS_STORE)
  const chunks = tx.objectStore(SYNC_SNAPSHOT_CHUNKS_STORE)

  const keysReq = workspaces.getAllKeys()
  keysReq.onsuccess = () => {
    const keys = keysReq.result.map(String)
    const hasLegacyRemnant = keys.includes(LEGACY_BROWSER_WORKSPACE_ID)
    const targetId = keys.find((key) => key !== LEGACY_BROWSER_WORKSPACE_ID) ?? generateDocumentId()

    if (!hasLegacyRemnant) {
      // Nothing to absorb this pass. A brand-new database (no row at all)
      // still needs its registry row written; an already-converged one is
      // left alone rather than re-put on every upgrade.
      if (keys.length === 0) workspaces.put({ workspaceId: targetId }, targetId)
      done()
      return
    }

    workspaces.delete(LEGACY_BROWSER_WORKSPACE_ID)
    workspaces.put({ workspaceId: targetId }, targetId)
    rekeyLegacyIndexRows(index, targetId, () => rekeyLegacySyncTree(sync, chunks, targetId, done))
  }
}

/** Moves every `documentIndex` row keyed under the legacy workspace onto `targetId`. */
function rekeyLegacyIndexRows(index: IDBObjectStore, targetId: string, done: () => void): void {
  const range = IDBKeyRange.bound([LEGACY_BROWSER_WORKSPACE_ID], [LEGACY_BROWSER_WORKSPACE_ID, []])
  const cursorReq = index.openCursor(range)
  cursorReq.onsuccess = () => {
    const cursor = cursorReq.result
    if (!cursor) {
      done()
      return
    }
    const row = cursor.value as Record<string, unknown>
    cursor.delete()
    // The new key's first element is `targetId`, entirely outside the
    // `'local'` range this cursor walks, so the add cannot be observed by
    // this same cursor and cannot loop.
    index.add({ ...row, workspaceId: targetId })
    cursor.continue()
  }
}

/**
 * Moves the `workspace-tree:local` sync record and its `syncSnapshotChunks`
 * rows onto `workspace-tree:<targetId>`, as opaque values — no Loro decode,
 * matching every other carrier in this file that only needs to relocate
 * bytes it does not need to understand.
 */
function rekeyLegacySyncTree(
  sync: IDBObjectStore,
  chunks: IDBObjectStore,
  targetId: string,
  done: () => void,
): void {
  const legacyKey = `workspace-tree:${LEGACY_BROWSER_WORKSPACE_ID}`
  const targetKey = `workspace-tree:${targetId}`
  const getReq = sync.get(legacyKey)
  getReq.onsuccess = () => {
    const value = getReq.result
    if (value === undefined) {
      done()
      return
    }
    sync.delete(legacyKey)
    sync.put(value, targetKey)
    const chunkRange = IDBKeyRange.bound([legacyKey], [legacyKey, []])
    const cursorReq = chunks.openCursor(chunkRange)
    cursorReq.onsuccess = () => {
      const cursor = cursorReq.result
      if (!cursor) {
        done()
        return
      }
      const [, chunkIndex] = cursor.primaryKey as [string, number]
      const chunkValue = cursor.value
      cursor.delete()
      chunks.add(chunkValue, [targetKey, chunkIndex])
      cursor.continue()
    }
  }
}

/**
 * The name the browser's own workspace answers to in a URL.
 *
 * A fixed word rather than something derived, because there is nothing to
 * derive from: the registry row carries no display name, and this is the one
 * workspace nobody chose to create. `default` asserts only what is true — the
 * workspace you get without choosing one — where `personal` or `home` would
 * assert a use the app cannot know. ADR-0019 makes a segment renameable, so a
 * word its owner dislikes costs exactly one rename.
 */
export const BROWSER_DEFAULT_SEGMENT = 'default'

/**
 * Gives the browser's sole workspace a segment, so an address can name it
 * instead of spelling its canonical ULID (ADR-0019: the visible URL carries
 * the segment, and the id resolves as the durable fallback).
 *
 * Convergent, like every carrier in this chain, and for a sharper reason than
 * the others: a rename is the FIRST thing anyone does to this value, and a
 * step that minted unconditionally would revert it on the next version bump —
 * the chain has no memory of having run. A segment already present is left
 * alone.
 *
 * Acts on a LONE segment-less row only. Once workspaces can be created in the
 * app, each one carries a segment chosen at creation, so a segment-less row
 * among several is an anomaly this step has no basis to name; it keeps the
 * canonical-id URL, which is what that fallback exists for.
 *
 * Exported for the same reason `rekeyBrowserWorkspace` is: the convergence
 * property can only be observed by running the step a second time, and
 * replaying the whole upgrade chain is not possible against stores later
 * versions have already dropped.
 */
export function mintBrowserWorkspaceSegment(tx: IDBTransaction, done: () => void): void {
  const workspaces = tx.objectStore(WORKSPACES_STORE)
  const rowsReq = workspaces.getAll()
  rowsReq.onsuccess = () => {
    const rows = rowsReq.result as Record<string, unknown>[]
    const sole = rows.length === 1 ? rows[0] : undefined
    if (sole === undefined || typeof sole.segment === 'string') {
      done()
      return
    }
    workspaces.put({ ...sole, segment: BROWSER_DEFAULT_SEGMENT }, String(sole.workspaceId))
    done()
  }
}

export function backfillDocumentIndex(tx: IDBTransaction, done: () => void): void {
  const documents = tx.objectStore('documents')
  const workspaces = tx.objectStore(WORKSPACES_STORE)
  const index = tx.objectStore(DOCUMENT_INDEX_STORE)
  workspaces.put({ workspaceId: 'local' }, 'local')
  const cursorReq = documents.openCursor()
  cursorReq.onsuccess = () => {
    const cursor = cursorReq.result
    if (!cursor) {
      // Only once the walk is done: deleting the store mid-cursor would end
      // the walk with rows still uncopied.
      tx.db.deleteObjectStore('documents')
      done()
      return
    }
    const row = cursor.value
    if (isPathAddressed(row)) {
      const { workspaceId, documentId, path, kind, name } = row
      workspaces.put({ workspaceId }, workspaceId)
      index.put({
        workspaceId,
        documentId,
        path,
        kind,
        ...(name === undefined || name === path ? {} : { name }),
      })
    }
    cursor.continue()
  }
}

/** The version at which a saved point began carrying its content's digest. */
export const VERSION_DIGEST_DB_VERSION = 19

/**
 * v19's sweep: empty the `versions` store of every point written before a row
 * carried the digest of the content it was taken of.
 *
 * Such a point can never gain one — a past checkpoint's content is reachable
 * only by checking the record out at its own frontier — so carrying them would
 * keep the old, workspace-scoped frontier comparison alive as a second read
 * path forever. At 0.0.x they go instead; the daemon's migration 0026 is the
 * same decision on the same data. A version is a frontier plus a row, never a
 * copy of content, so what a reader loses is the ability to look back.
 *
 * Exported and told which version it is upgrading FROM rather than inlined,
 * because that bound is the whole correctness of it and is otherwise
 * untestable until a v20 exists. Every other step in the handler is idempotent
 * — "create it if absent", "delete it if present"; this one, run again at
 * v19 -> v20, would empty a store whose rows are by then exactly the ones the
 * digest was added to keep.
 *
 * `clear()` rather than a cursor deleting the digest-less rows: every row
 * written before v19 lacks one, so the two are the same operation, and the v18
 * note above says why a cursor over THIS store is the dangerous way to write
 * it.
 */
export function sweepVersionsWrittenBeforeDigests(tx: IDBTransaction, oldVersion: number): void {
  // oldVersion 0 is a fresh install: nothing a sweep could mean.
  if (oldVersion === 0 || oldVersion >= VERSION_DIGEST_DB_VERSION) return
  tx.objectStore(VERSIONS_STORE).clear()
}

export function renameMetaKey(tx: IDBTransaction, from: string, to: string): void {
  const meta = tx.objectStore('meta')
  const req = meta.get(from)
  req.onsuccess = () => {
    if (req.result === undefined) return
    meta.put(req.result, to)
    meta.delete(from)
  }
}
