import type { Kysely } from 'kysely'
import { LoroDoc } from 'loro-crdt'

/**
 * Adopt documents that exist only in the RETIRED workspace-tree docs into the
 * `canvases` table.
 *
 * When document addressing moved onto the canvases table, everything the old
 * workspace-tree Loro doc knew — every document an agent had created through
 * the MCP tools — became unreachable: the snapshots were still on disk, but
 * no row named them, so every list and lookup answered "not found" over data
 * that was fully intact. This walks each `workspace-tree:<workspaceId>` doc
 * still in the snapshot store and inserts the missing rows.
 *
 * The retired format is FROZEN here rather than imported: the code that wrote
 * it was deleted in the same change that retired it, which is exactly why a
 * migration cannot depend on living code. Shape: a LoroDoc whose LoroTree
 * lives under the container key `tree`, node data
 * `{ canvasId, segment, displayName? }`; a document's path is its root-to-leaf
 * segment chain; a node with no `canvasId` is a pure folder. A document's
 * `kind` was never in the tree — it lives in the canvas doc itself, under
 * `getMap('document').get('kind')`, where it still lives today.
 *
 * Rules, each carrying a reason:
 * - A canvasId that already has a row anywhere in the workspace is SKIPPED:
 *   adoption must be idempotent, and never re-paths a row somebody can see.
 * - A derived path already taken by another row adopts under `<path>-2`,
 *   `<path>-3`, … instead of failing: the occupant is typically a gallery
 *   canvas the tree never knew, and one collision must not abort the whole
 *   recovery.
 * - A tree whose snapshot cannot be decoded is skipped, not fatal: this runs
 *   inside db bootstrap, and refusing to start the daemon over one corrupt
 *   retired doc would turn a recovery into an outage.
 * - The tree docs themselves are left in place. They are inert — nothing
 *   reads them any more — and a migration that deletes its own input cannot
 *   be re-run to diagnose what it did.
 */
export const migration = {
  async up(db: Kysely<unknown>): Promise<void> {
    const tdb = db as Kysely<MigrationSchema>
    const treeRows = await tdb
      .selectFrom('canvasDocSnapshots')
      .select(['docKey'])
      .where('docKey', 'like', 'workspace-tree:%')
      .execute()

    for (const { docKey } of treeRows) {
      const workspaceId = docKey.slice('workspace-tree:'.length)
      const treeDoc = await loadStoredDoc(tdb, docKey)
      if (treeDoc === null) continue

      const documents = walkRetiredTree(treeDoc)
      if (documents.length === 0) continue

      const now = Date.now()
      await tdb
        .insertInto('workspaces')
        .values({ id: workspaceId, createdAt: now, updatedAt: now })
        .onConflict((oc) => oc.column('id').doNothing())
        .execute()

      const existing = await tdb
        .selectFrom('canvases')
        .select(['id', 'slug'])
        .where('workspaceId', '=', workspaceId)
        .execute()
      const adoptedIds = new Set(existing.map((row) => row.id))
      const takenPaths = new Set(existing.map((row) => row.slug))

      for (const entry of documents) {
        if (adoptedIds.has(entry.canvasId)) continue
        let path = entry.path
        for (let suffix = 2; takenPaths.has(path); suffix++) {
          path = `${entry.path}-${suffix}`
        }
        const kind = await readStoredKind(tdb, entry.canvasId)
        await tdb
          .insertInto('canvases')
          .values({
            id: entry.canvasId,
            workspaceId,
            slug: path,
            displayName: entry.displayName ?? null,
            isPinned: 0,
            pinOrder: null,
            currentBranch: 'main',
            createdAt: now,
            updatedAt: now,
            kind,
          })
          .execute()
        adoptedIds.add(entry.canvasId)
        takenPaths.add(path)
      }
    }
  },

  async down(): Promise<void> {
    // Adoption only inserts rows for documents that had none; there is no
    // record of which rows it created, so down is a no-op by design.
  },
}

interface MigrationSchema {
  workspaces: {
    id: string
    createdAt: number
    updatedAt: number
  }
  canvases: {
    id: string
    workspaceId: string
    slug: string
    displayName: string | null
    isPinned: number
    pinOrder: number | null
    currentBranch: string
    createdAt: number
    updatedAt: number
    kind: string | null
  }
  canvasDocSnapshots: {
    docKey: string
    chunkCount: number
    totalBytes: number
    maxChunkBytes: number
    frontier: Uint8Array
  }
  canvasDocSnapshotChunks: {
    docKey: string
    chunkIndex: number
    bytes: Uint8Array
  }
  canvasDocDeltas: {
    docKey: string
    seq: number
    bytes: Uint8Array
    frontier: Uint8Array
  }
}

/** Reassemble and import a stored doc: snapshot chunks in order, then deltas. */
async function loadStoredDoc(db: Kysely<MigrationSchema>, docKey: string): Promise<LoroDoc | null> {
  try {
    const chunks = await db
      .selectFrom('canvasDocSnapshotChunks')
      .select(['chunkIndex', 'bytes'])
      .where('docKey', '=', docKey)
      .orderBy('chunkIndex', 'asc')
      .execute()
    if (chunks.length === 0) return null
    const doc = new LoroDoc()
    const total = chunks.reduce((sum, chunk) => sum + toBytes(chunk.bytes).byteLength, 0)
    const snapshot = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) {
      const bytes = toBytes(chunk.bytes)
      snapshot.set(bytes, offset)
      offset += bytes.byteLength
    }
    doc.import(snapshot)
    const deltas = await db
      .selectFrom('canvasDocDeltas')
      .select(['bytes'])
      .where('docKey', '=', docKey)
      .orderBy('seq', 'asc')
      .execute()
    for (const delta of deltas) {
      doc.import(toBytes(delta.bytes))
    }
    return doc
  } catch {
    return null
  }
}

/** Drivers hand blobs back as Buffer or Uint8Array depending on dialect. */
function toBytes(value: Uint8Array): Uint8Array {
  return value instanceof Uint8Array ? value : new Uint8Array(value)
}

interface RetiredDocument {
  canvasId: string
  path: string
  displayName?: string
}

function walkRetiredTree(doc: LoroDoc): RetiredDocument[] {
  const out: RetiredDocument[] = []
  const tree = doc.getTree('tree')
  const visit = (node: TreeNodeLike, prefix: string[]): void => {
    const segment = node.data.get('segment')
    const chain = typeof segment === 'string' ? [...prefix, segment] : prefix
    const canvasId = node.data.get('canvasId')
    if (typeof canvasId === 'string' && chain.length > 0) {
      const displayName = node.data.get('displayName')
      out.push({
        canvasId,
        path: chain.join('/'),
        ...(typeof displayName === 'string' ? { displayName } : {}),
      })
    }
    for (const child of node.children() ?? []) visit(child, chain)
  }
  for (const root of tree.roots()) visit(root as TreeNodeLike, [])
  return out
}

/** The slice of LoroTreeNode this walk touches, so loro-crdt type churn cannot break the frozen reader. */
interface TreeNodeLike {
  data: { get(key: string): unknown }
  children(): TreeNodeLike[] | undefined
}

async function readStoredKind(
  db: Kysely<MigrationSchema>,
  canvasId: string,
): Promise<string | null> {
  const doc = await loadStoredDoc(db, `canvas:${canvasId}`)
  if (doc === null) return null
  const kind = doc.getMap('document').get('kind')
  return kind === 'spatial' || kind === 'markdown' ? kind : null
}
