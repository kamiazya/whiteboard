import { Kysely, SqliteDialect, sql } from 'kysely'
import LibsqlNativeDatabase from 'libsql'
import { LoroDoc } from 'loro-crdt'
import { describe, expect, it } from 'vitest'
import type { DatabaseSchema } from '../schema.js'
import { migration as migration0001 } from './0001-init.js'
import { migration as migration0002 } from './0002-canvases-last-compacted-at.js'
import { migration as migration0003 } from './0003-canvas-doc-store.js'
import { migration as migration0005 } from './0005-canvases-kind.js'
import { migration } from './0007-adopt-workspace-tree.js'

async function createMemoryDb(): Promise<Kysely<DatabaseSchema>> {
  const db = new Kysely<DatabaseSchema>({
    dialect: new SqliteDialect({
      database: new LibsqlNativeDatabase(':memory:') as unknown as ConstructorParameters<
        typeof SqliteDialect
      >[0]['database'],
    }),
  })
  await sql`PRAGMA foreign_keys = ON`.execute(db)
  await migration0001.up(db as unknown as Kysely<unknown>)
  await migration0002.up(db as unknown as Kysely<unknown>)
  await migration0003.up(db as unknown as Kysely<unknown>)
  await migration0005.up(db as unknown as Kysely<unknown>)
  return db
}

/** Store a doc as ONE snapshot chunk, the way the doc store writes it. */
async function storeDoc(db: Kysely<DatabaseSchema>, docKey: string, doc: LoroDoc): Promise<void> {
  const bytes = doc.export({ mode: 'snapshot' })
  const frontier = new Uint8Array([0])
  await db
    .insertInto('canvasDocSnapshots')
    .values({
      docKey,
      chunkCount: 1,
      totalBytes: bytes.byteLength,
      maxChunkBytes: 1 << 20,
      frontier,
    })
    .execute()
  await db.insertInto('canvasDocSnapshotChunks').values({ docKey, chunkIndex: 0, bytes }).execute()
  await db.insertInto('canvasDocFrontiers').values({ docKey, frontier }).execute()
}

/**
 * A workspace tree exactly as the retired format stored it: a LoroDoc with a
 * LoroTree under the container key `tree`, node data `{ canvasId, segment,
 * displayName? }`. Frozen here rather than imported: the living code that
 * wrote this format was deleted when the tree retired, which is the point of
 * the migration existing.
 */
function retiredTree(
  docs: { canvasId: string; segments: string[]; displayName?: string }[],
): LoroDoc {
  const doc = new LoroDoc()
  const tree = doc.getTree('tree')
  const byPath = new Map<string, ReturnType<typeof tree.createNode>>()
  for (const entry of docs) {
    let parent: ReturnType<typeof tree.createNode> | undefined
    for (let depth = 0; depth < entry.segments.length; depth++) {
      const prefix = entry.segments.slice(0, depth + 1).join('/')
      let node = byPath.get(prefix)
      if (!node) {
        node = parent === undefined ? tree.createNode() : parent.createNode()
        node.data.set('segment', entry.segments[depth] as string)
        byPath.set(prefix, node)
      }
      parent = node
    }
    const leaf = byPath.get(entry.segments.join('/'))
    if (!leaf) throw new Error('unreachable')
    leaf.data.set('canvasId', entry.canvasId)
    if (entry.displayName !== undefined) leaf.data.set('displayName', entry.displayName)
  }
  doc.commit()
  return doc
}

/** A canvas doc carrying its kind the way loro-bridge stores it. */
function canvasDoc(kind: 'spatial' | 'markdown'): LoroDoc {
  const doc = new LoroDoc()
  doc.getMap('document').set('kind', kind)
  doc.commit()
  return doc
}

const ULID_A = '01ARZ3NDEKTSV4RRFFQ69G5FAA'
const ULID_B = '01ARZ3NDEKTSV4RRFFQ69G5FAB'
const ULID_C = '01ARZ3NDEKTSV4RRFFQ69G5FAC'

describe('0007-adopt-workspace-tree migration', () => {
  it('adopts tree documents into the canvases table with derived paths, names and kinds', async () => {
    const db = await createMemoryDb()
    try {
      await storeDoc(
        db,
        'workspace-tree:default',
        retiredTree([
          { canvasId: ULID_A, segments: ['notes'], displayName: 'My notes' },
          { canvasId: ULID_B, segments: ['plans', 'q3'] },
        ]),
      )
      await storeDoc(db, `document:${ULID_A}`, canvasDoc('markdown'))
      await storeDoc(db, `document:${ULID_B}`, canvasDoc('spatial'))

      await migration.up(db as unknown as Kysely<unknown>)

      const rows = await db
        .selectFrom('canvases')
        .select(['id', 'workspaceId', 'slug', 'kind', 'displayName'])
        .orderBy('slug', 'asc')
        .execute()
      expect(rows).toEqual([
        {
          id: ULID_A,
          workspaceId: 'default',
          slug: 'notes',
          kind: 'markdown',
          displayName: 'My notes',
        },
        {
          id: ULID_B,
          workspaceId: 'default',
          slug: 'plans/q3',
          kind: 'spatial',
          displayName: null,
        },
      ])
      const workspaces = await db.selectFrom('workspaces').select('id').execute()
      expect(workspaces).toEqual([{ id: 'default' }])
    } finally {
      await db.destroy()
    }
  })

  it('leaves an already-adopted document alone and suffixes a taken path', async () => {
    const db = await createMemoryDb()
    try {
      // ULID_A is already in the table (say, adopted by an earlier run, or
      // the same id was re-created through the index): the migration must be
      // idempotent for it. ULID_C wants the path `notes`, which is taken by a
      // ROW THE TREE NEVER KNEW — a gallery canvas — so it adopts under a
      // suffixed path instead of failing the whole migration.
      const now = Date.now()
      await db
        .insertInto('workspaces')
        .values({ id: 'default', createdAt: now, updatedAt: now })
        .execute()
      await db
        .insertInto('canvases')
        .values([
          {
            id: ULID_A,
            workspaceId: 'default',
            slug: 'already-here',
            kind: 'spatial',
            createdAt: now,
            updatedAt: now,
          },
          {
            id: 'Go1G4OcJKUBu',
            workspaceId: 'default',
            slug: 'notes',
            kind: 'spatial',
            createdAt: now,
            updatedAt: now,
          },
        ])
        .execute()
      await storeDoc(
        db,
        'workspace-tree:default',
        retiredTree([
          { canvasId: ULID_A, segments: ['moved-elsewhere'] },
          { canvasId: ULID_C, segments: ['notes'] },
        ]),
      )
      await storeDoc(db, `document:${ULID_C}`, canvasDoc('markdown'))

      await migration.up(db as unknown as Kysely<unknown>)

      const rows = await db.selectFrom('canvases').select(['id', 'slug']).execute()
      const bySlug = new Map(rows.map((r) => [r.id, r.slug]))
      // Untouched: adoption never re-paths a row that already exists.
      expect(bySlug.get(ULID_A)).toBe('already-here')
      expect(bySlug.get('Go1G4OcJKUBu')).toBe('notes')
      // Adopted beside the occupant rather than over it or not at all.
      expect(bySlug.get(ULID_C)).toBe('notes-2')
    } finally {
      await db.destroy()
    }
  })
})
