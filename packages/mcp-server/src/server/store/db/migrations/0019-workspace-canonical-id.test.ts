/**
 * ADR-0019's canonical layer: a workspace is keyed by a bare ULID, and the
 * string a human typed becomes its `segment`. This migration re-keys every
 * workspace a daemon already holds.
 *
 * The re-key has to move everything that names a workspace at once —
 * dependent rows, four `docKey` tables, a runtime marker, and two directory
 * trees on disk. What makes that safe to write as plain statements rather
 * than as 0008's ordering dance is measured, not assumed: on a fully
 * migrated database the ONLY foreign key left in the schema is
 * `documentSnapshotChunks.docKey -> documentSnapshots.docKey`, so the
 * snapshot pair needs 0013's copy-then-delete and nothing else does.
 */
import { mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWorkspaceDocument } from '@kamiazya/whiteboard-loro-adapter'
import { generateDocumentId } from '@kamiazya/whiteboard-model'
import { Kysely, type MigrationProvider, Migrator, SqliteDialect, sql } from 'kysely'
import LibsqlNativeDatabase from 'libsql'
import { LoroDoc } from 'loro-crdt'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { migrations } from './index.js'

let dataDir = ''
vi.mock('../../../config.js', () => ({
  get DATA_DIR() {
    return dataDir
  },
  getDataDir: () => dataDir,
}))

const PRE_0019 = '0018-workspace-segment'
const CANONICAL = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/

interface Handle {
  db: Kysely<Record<string, Record<string, unknown>>>
  migrateTo(name: string): Promise<void>
  migrateToHead(): Promise<void>
}

async function openDb(): Promise<Handle> {
  const db = new Kysely<Record<string, Record<string, unknown>>>({
    dialect: new SqliteDialect({
      database: new LibsqlNativeDatabase(
        join(dataDir, 'whiteboard.db'),
      ) as unknown as ConstructorParameters<typeof SqliteDialect>[0]['database'],
    }),
  })
  await sql`PRAGMA foreign_keys = ON`.execute(db)
  const provider: MigrationProvider = { getMigrations: async () => migrations }
  const migrator = new Migrator({ db: db as never, provider })
  return {
    db,
    async migrateTo(name: string) {
      const { error } = await migrator.migrateTo(name)
      expect(error).toBeUndefined()
    },
    async migrateToHead() {
      const { error } = await migrator.migrateToLatest()
      expect(error).toBeUndefined()
    },
  }
}

/** A workspace as a pre-0019 writer left it: the handle IS the id. */
async function seedWorkspace(handle: Handle, workspaceId: string): Promise<void> {
  const now = Date.now()
  const { db } = handle
  await db
    .insertInto('workspaces')
    .values({ id: workspaceId, displayName: null, segment: null, createdAt: now, updatedAt: now })
    .execute()
  await db
    .insertInto('branches')
    .values({
      documentId: `doc-${workspaceId}`,
      workspaceId,
      name: 'main',
      tipFrontiers: '[]',
      color: null,
      sourceBranchName: null,
      sourceVersionId: null,
      createdAt: now,
    })
    .execute()
  await db
    .insertInto('versions')
    .values({
      id: `v-${workspaceId}`,
      documentId: `doc-${workspaceId}`,
      workspaceId,
      branchName: 'main',
      auto: 0,
      label: null,
      operatorKind: 'human',
      operatorPeerId: 'peer-1',
      operatorDisplayName: null,
      operatorAgentId: null,
      // Attribution: which workspace the operator was acting in. Points at
      // this daemon's own workspace here, which is the case the re-key has
      // to move; a foreign value it does not recognise must be left alone.
      operatorWorkspaceId: workspaceId,
      elementCount: 0,
      frontiers: '[]',
      hasThumbnail: 0,
      createdAt: now,
    })
    .execute()

  const docKey = `workspace-tree:${workspaceId}`
  await db
    .insertInto('documentSnapshots')
    .values({
      docKey,
      chunkCount: 1,
      totalBytes: 3,
      maxChunkBytes: 3,
      frontier: Uint8Array.from([1, 2, 3]),
    })
    .execute()
  await db
    .insertInto('documentSnapshotChunks')
    .values({ docKey, chunkIndex: 0, bytes: Uint8Array.from([9, 9, 9]) })
    .execute()
  await db
    .insertInto('documentDeltas')
    .values({ docKey, seq: 1, bytes: Uint8Array.from([4]), frontier: Uint8Array.from([5]) })
    .execute()
  await db
    .insertInto('documentFrontiers')
    .values({ docKey, frontier: Uint8Array.from([6]) })
    .execute()

  // The two workspace-keyed directory trees on disk.
  await mkdir(join(dataDir, workspaceId, 'files'), { recursive: true })
  await writeFile(join(dataDir, workspaceId, 'files', 'a.png'), 'png')
  await mkdir(join(dataDir, 'blobs', workspaceId, 'versions'), { recursive: true })
  await writeFile(join(dataDir, 'blobs', workspaceId, 'versions', 'v1.png'), 'thumb')
}

async function setCurrentWorkspace(handle: Handle, workspaceId: string): Promise<void> {
  await handle.db
    .insertInto('runtime')
    .values({ key: 'currentWorkspaceId', value: workspaceId, updatedAt: Date.now() })
    .execute()
}

async function idOf(handle: Handle, segment: string | null): Promise<string> {
  const row = await handle.db
    .selectFrom('workspaces')
    .select(['id'])
    .where('segment', segment === null ? 'is' : '=', segment)
    .executeTakeFirstOrThrow()
  return row.id as string
}

describe('0019-workspace-canonical-id', () => {
  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'migration-0019-'))
  })

  it('re-keys a legacy workspace onto a ULID and keeps the old handle as its segment', async () => {
    const handle = await openDb()
    await handle.migrateTo(PRE_0019)
    await seedWorkspace(handle, 'default')

    await handle.migrateToHead()

    const rows = await handle.db.selectFrom('workspaces').select(['id', 'segment']).execute()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.id).toMatch(CANONICAL)
    // `default` is segment-valid, so the address a user already types keeps
    // working through segment-first resolution rather than being retired.
    expect(rows[0]?.segment).toBe('default')
  })

  it('leaves the segment NULL when the old handle cannot be one', async () => {
    const handle = await openDb()
    await handle.migrateTo(PRE_0019)
    // A nanoid-minted id: `_` is outside the segment charset, so there is no
    // honest segment to carry over. NULL rather than a mangled approximation
    // — a segment nobody chose is worse than none.
    await seedWorkspace(handle, 'V1StGXR8_Z5jdHi6B-myT')

    await handle.migrateToHead()

    const rows = await handle.db.selectFrom('workspaces').select(['id', 'segment']).execute()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.id).toMatch(CANONICAL)
    expect(rows[0]?.segment).toBeNull()
  })

  it('moves every row and docKey that named the workspace', async () => {
    const handle = await openDb()
    await handle.migrateTo(PRE_0019)
    await seedWorkspace(handle, 'default')
    await setCurrentWorkspace(handle, 'default')

    await handle.migrateToHead()
    const newId = await idOf(handle, 'default')

    const branch = await handle.db
      .selectFrom('branches')
      .select(['workspaceId'])
      .executeTakeFirstOrThrow()
    expect(branch.workspaceId).toBe(newId)

    const version = await handle.db
      .selectFrom('versions')
      .select(['workspaceId', 'operatorWorkspaceId'])
      .executeTakeFirstOrThrow()
    expect(version.workspaceId).toBe(newId)
    expect(version.operatorWorkspaceId).toBe(newId)

    const marker = await handle.db
      .selectFrom('runtime')
      .select(['value'])
      .where('key', '=', 'currentWorkspaceId')
      .executeTakeFirstOrThrow()
    expect(marker.value).toBe(newId)

    const newKey = `workspace-tree:${newId}`
    for (const table of [
      'documentSnapshots',
      'documentSnapshotChunks',
      'documentDeltas',
      'documentFrontiers',
    ]) {
      const keys = await handle.db.selectFrom(table).select(['docKey']).execute()
      expect(keys.map((r) => r.docKey)).toEqual([newKey])
    }
    // The one FK in the schema: the chunk must survive the parent's move
    // with its BYTES, which a delete-then-reinsert of the parent alone would
    // have cascaded away.
    // Read as an ArrayBuffer, which is what this raw handle hands back for a
    // blob — `Array.from` on one answers `[]` whether or not the bytes
    // survived, so the length is asserted in SQL as well rather than trusting
    // a JS view to have reached the column at all.
    const chunk = await handle.db
      .selectFrom('documentSnapshotChunks')
      .select(['bytes'])
      .executeTakeFirstOrThrow()
    expect(Array.from(new Uint8Array(chunk.bytes as ArrayBuffer))).toEqual([9, 9, 9])
    const size = await sql<{ n: number }>`
      select length("bytes") as n from "documentSnapshotChunks"
    `.execute(handle.db)
    expect(size.rows.map((r) => r.n)).toEqual([3])
  })

  it('renames both workspace-keyed directory trees on disk', async () => {
    const handle = await openDb()
    await handle.migrateTo(PRE_0019)
    await seedWorkspace(handle, 'default')

    await handle.migrateToHead()
    const newId = await idOf(handle, 'default')

    expect(await readdir(join(dataDir, newId, 'files'))).toEqual(['a.png'])
    expect(await readdir(join(dataDir, 'blobs', newId, 'versions'))).toEqual(['v1.png'])
    expect(await readdir(dataDir)).not.toContain('default')
    expect(await readdir(join(dataDir, 'blobs'))).not.toContain('default')
  })

  it('leaves a workspace that is already canonically keyed exactly as it is', async () => {
    const handle = await openDb()
    await handle.migrateTo(PRE_0019)
    await seedWorkspace(handle, '01ARZ3NDEKTSV4RRFFQ69G5FAV')

    await handle.migrateToHead()

    const rows = await handle.db.selectFrom('workspaces').select(['id', 'segment']).execute()
    // Untouched, and NOT given itself as a segment — a ULID-shaped segment is
    // exactly what workspaceSegmentSchema forbids, because it would collide
    // with the canonical-id fallback in the one address position.
    expect(rows).toEqual([{ id: '01ARZ3NDEKTSV4RRFFQ69G5FAV', segment: null }])
    const keys = await handle.db.selectFrom('documentFrontiers').select(['docKey']).execute()
    expect(keys.map((r) => r.docKey)).toEqual(['workspace-tree:01ARZ3NDEKTSV4RRFFQ69G5FAV'])
  })

  it('re-keys several workspaces independently in one run', async () => {
    const handle = await openDb()
    await handle.migrateTo(PRE_0019)
    await seedWorkspace(handle, 'default')
    await seedWorkspace(handle, 'notes')

    await handle.migrateToHead()

    const rows = await handle.db
      .selectFrom('workspaces')
      .select(['id', 'segment'])
      .orderBy('segment')
      .execute()
    expect(rows.map((r) => r.segment)).toEqual(['default', 'notes'])
    const ids = rows.map((r) => r.id as string)
    expect(ids.every((id) => CANONICAL.test(id))).toBe(true)
    expect(new Set(ids).size).toBe(2)
    // Each workspace's own tree moved with it, rather than both landing on
    // whichever id was minted last.
    const keys = await handle.db
      .selectFrom('documentFrontiers')
      .select(['docKey'])
      .orderBy('docKey')
      .execute()
    expect(keys.map((r) => r.docKey).sort()).toEqual(ids.map((id) => `workspace-tree:${id}`).sort())
  })

  it('leaves the workspace reachable by the handle a user already types', async () => {
    // The point of the whole two-stage ordering, asserted end to end rather
    // than argued: the id under every row changes, and the address does not.
    // A DB-level check cannot say this — it is the ROUTE, resolving
    // segment-first (Stage 1b), that has to answer.
    //
    // Seeded as a REAL workspace tree at the pre-0019 point, because the
    // route reads one: fake snapshot bytes would fail to import and the case
    // would pass or fail for a reason that has nothing to do with addressing.
    const handle = await openDb()
    await handle.migrateTo(PRE_0019)
    await handle.db
      .insertInto('workspaces')
      .values({
        id: 'default',
        displayName: null,
        segment: null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
      .execute()

    const tree = new LoroDoc()
    createWorkspaceDocument(tree, {
      documentId: generateDocumentId(),
      segment: 'spec',
      kind: 'markdown',
    })
    const snapshot = tree.export({ mode: 'snapshot' })
    await handle.db
      .insertInto('documentSnapshots')
      .values({
        docKey: 'workspace-tree:default',
        chunkCount: 1,
        totalBytes: snapshot.length,
        maxChunkBytes: snapshot.length,
        frontier: Uint8Array.from([]),
      })
      .execute()
    await handle.db
      .insertInto('documentSnapshotChunks')
      .values({ docKey: 'workspace-tree:default', chunkIndex: 0, bytes: snapshot })
      .execute()

    await handle.migrateToHead()
    await handle.db.destroy()

    const newId = await (async () => {
      const h = await openDb()
      const row = await h.db.selectFrom('workspaces').select(['id']).executeTakeFirstOrThrow()
      await h.db.destroy()
      return row.id as string
    })()
    expect(newId).toMatch(CANONICAL)
    expect(newId).not.toBe('default')

    const { createWorkspacesRouter } = await import('../../../routes/document/workspaces.js')
    const app = createWorkspacesRouter()
    const bySegment = await app.request('/api/workspaces/default/documents')
    const byId = await app.request(`/api/workspaces/${newId}/documents`)

    expect(byId.status).toBe(200)
    const canonical = (await byId.json()) as { documents: { path: string }[] }
    expect(canonical.documents.map((d) => d.path)).toEqual(['spec'])
    expect(bySegment.status).toBe(200)
    expect(await bySegment.json()).toEqual(canonical)
  })
})
