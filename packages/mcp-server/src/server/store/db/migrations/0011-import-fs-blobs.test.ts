import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chunkSnapshot, reassembleSnapshot } from '@kamiazya/whiteboard-ports'
import { Kysely, type MigrationProvider, Migrator, SqliteDialect, sql } from 'kysely'
import LibsqlNativeDatabase from 'libsql'
import { encodeFrontiers, LoroDoc } from 'loro-crdt'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CAN_DENY_FILE_READ } from '../../../../shared/test-utils/can-deny-file-read.js'
import type { DatabaseSchema } from '../schema.js'

let dataDir = ''
vi.mock('../../../config.js', () => ({
  get DATA_DIR() {
    return dataDir
  },
  getDataDir: () => dataDir,
}))

const { captureLogsForTests } = await import('../../../log.js')
const { migrations } = await import('./index.js')
const { importFsBlobs, migration } = await import('./0011-import-fs-blobs.js')

const BEFORE = '0010-document-path'
const THIS_ONE = '0011-import-fs-blobs'

async function memoryDb(): Promise<Kysely<DatabaseSchema>> {
  const db = new Kysely<DatabaseSchema>({
    dialect: new SqliteDialect({
      database: new LibsqlNativeDatabase(':memory:') as unknown as ConstructorParameters<
        typeof SqliteDialect
      >[0]['database'],
    }),
  })
  await sql`PRAGMA foreign_keys = ON`.execute(db)
  return db
}

function migratorFor(db: Kysely<DatabaseSchema>): Migrator {
  const provider: MigrationProvider = { getMigrations: async () => migrations }
  return new Migrator({ db: db as never, provider })
}

async function seedWorkspace(db: Kysely<DatabaseSchema>, workspaceId: string): Promise<void> {
  await db
    .insertInto('workspaces')
    .values({ id: workspaceId, displayName: null, createdAt: 0, updatedAt: 0 })
    .onConflict((oc) => oc.doNothing())
    .execute()
}

/** A real, decodable LoroDoc snapshot — the migration validates via LoroDoc.import. */
function snapshotBytes(text: string): Uint8Array {
  const doc = new LoroDoc()
  doc.getText('t').insert(0, text)
  doc.commit()
  return doc.export({ mode: 'snapshot' })
}

/**
 * High-entropy text: loro's snapshot encoding compresses low-entropy input
 * hard enough that a `.repeat()`ed string, or even a simple LCG sequence,
 * stays under 40KB for 600K characters — nowhere near enough to force a
 * second chunk. `Math.random()` is good enough here; only the byte count
 * matters, not reproducibility of the exact bytes.
 */
function highEntropyText(length: number): string {
  let out = ''
  for (let i = 0; i < length; i++) {
    out += String.fromCharCode(33 + Math.floor(Math.random() * 90))
  }
  return out
}

function expectedFrontier(bytes: Uint8Array): Uint8Array {
  const doc = new LoroDoc()
  doc.import(bytes)
  return encodeFrontiers(doc.oplogFrontiers())
}

async function writeBlob(
  root: string,
  workspaceId: string,
  documentId: string,
  bytes: Uint8Array,
): Promise<string> {
  const dir = join(root, 'blobs', workspaceId, 'canvas')
  await mkdir(dir, { recursive: true })
  const path = join(dir, `${documentId}.loro`)
  await writeFile(path, bytes)
  return path
}

async function reassembledRow(
  db: Kysely<DatabaseSchema>,
  docKey: string,
): Promise<Uint8Array | null> {
  const header = await db
    .selectFrom('documentSnapshots')
    .select(['chunkCount', 'totalBytes', 'maxChunkBytes'])
    .where('docKey', '=', docKey)
    .executeTakeFirst()
  if (!header) return null
  const chunkRows = await db
    .selectFrom('documentSnapshotChunks')
    .select(['chunkIndex', 'bytes'])
    .where('docKey', '=', docKey)
    .orderBy('chunkIndex', 'asc')
    .execute()
  return reassembleSnapshot(
    header,
    chunkRows.map((row) => ({
      index: row.chunkIndex,
      of: header.chunkCount,
      bytes: row.bytes instanceof Uint8Array ? row.bytes : new Uint8Array(row.bytes),
    })),
  )
}

describe('0011-import-fs-blobs', () => {
  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'whiteboard-0011-'))
  })

  it('imports a blob with no existing row, byte-identical on reassembly, with a matching frontier', async () => {
    const db = await memoryDb()
    expect((await migratorFor(db).migrateTo(BEFORE)).error).toBeUndefined()
    await seedWorkspace(db, 'ws-1')

    const bytes = snapshotBytes('hello world')
    await writeBlob(dataDir, 'ws-1', 'doc-a', bytes)

    expect((await migratorFor(db).migrateTo(THIS_ONE)).error).toBeUndefined()

    const reassembled = await reassembledRow(db, 'canvas:doc-a')
    expect(reassembled).toEqual(bytes)

    const frontierRow = await db
      .selectFrom('documentFrontiers')
      .select('frontier')
      .where('docKey', '=', 'canvas:doc-a')
      .executeTakeFirstOrThrow()
    const frontier =
      frontierRow.frontier instanceof Uint8Array
        ? frontierRow.frontier
        : new Uint8Array(frontierRow.frontier)
    expect(frontier).toEqual(expectedFrontier(bytes))

    await db.destroy()
  })

  it('chunks a blob larger than the chunk size into more than one chunk row', async () => {
    // The threshold is injected rather than the blob inflated past the real
    // one. What is under test is "over the size, so it splits" — and saying
    // that with 1.3MB pushed through SQLite made this the slowest test in
    // the suite and the first to blow the 10s per-test budget whenever the
    // whole project ran in parallel. Isolated it passed, which is exactly
    // what made it look like a flake.
    const db = await memoryDb()
    expect((await migratorFor(db).migrateTo(THIS_ONE)).error).toBeUndefined()
    await seedWorkspace(db, 'ws-1')

    const bytes = snapshotBytes(highEntropyText(4_000))
    const maxChunkBytes = 1_000
    expect(bytes.byteLength).toBeGreaterThan(maxChunkBytes)
    await writeBlob(dataDir, 'ws-1', 'doc-big', bytes)

    await importFsBlobs(
      db as unknown as Parameters<typeof importFsBlobs>[0],
      dataDir,
      'canvas:',
      maxChunkBytes,
    )

    const header = await db
      .selectFrom('documentSnapshots')
      .select(['chunkCount', 'totalBytes'])
      .where('docKey', '=', 'canvas:doc-big')
      .executeTakeFirstOrThrow()
    expect(header.chunkCount).toBeGreaterThan(1)
    expect(header.totalBytes).toBe(bytes.byteLength)

    const reassembled = await reassembledRow(db, 'canvas:doc-big')
    expect(reassembled).toEqual(bytes)

    await db.destroy()
  })

  it('logs a structured warning and leaves both sides untouched when a row already exists with different bytes', async () => {
    const db = await memoryDb()
    expect((await migratorFor(db).migrateTo(BEFORE)).error).toBeUndefined()
    await seedWorkspace(db, 'ws-1')

    const existingBytes = snapshotBytes('existing content')
    const { manifest, chunks } = chunkSnapshot(existingBytes, 1_000_000)
    await db
      .insertInto('documentSnapshots')
      .values({
        docKey: 'canvas:doc-b',
        chunkCount: manifest.chunkCount,
        totalBytes: manifest.totalBytes,
        maxChunkBytes: manifest.maxChunkBytes,
        frontier: new Uint8Array([9]),
      })
      .execute()
    await db
      .insertInto('documentSnapshotChunks')
      .values(chunks.map((c) => ({ docKey: 'canvas:doc-b', chunkIndex: c.index, bytes: c.bytes })))
      .execute()

    const blobBytes = snapshotBytes('a totally different document')
    const blobPath = await writeBlob(dataDir, 'ws-1', 'doc-b', blobBytes)
    const statBefore = await import('node:fs/promises').then((fs) => fs.stat(blobPath))

    const capture = captureLogsForTests()
    try {
      expect((await migratorFor(db).migrateTo(THIS_ONE)).error).toBeUndefined()

      const warnings = capture.records.filter(
        (r) => r.level === 'warning' && r.data?.documentId === 'doc-b',
      )
      expect(warnings).toHaveLength(1)
      expect(warnings[0]?.data?.workspaceId).toBe('ws-1')
      expect(warnings[0]?.data?.existingBytes).toBe(existingBytes.byteLength)
      expect(warnings[0]?.data?.blobBytes).toBe(blobBytes.byteLength)
    } finally {
      capture.restore()
    }

    // Neither side moved.
    const reassembled = await reassembledRow(db, 'canvas:doc-b')
    expect(reassembled).toEqual(existingBytes)
    const statAfter = await import('node:fs/promises').then((fs) => fs.stat(blobPath))
    expect(statAfter.mtimeMs).toBe(statBefore.mtimeMs)
    expect(statAfter.size).toBe(blobBytes.byteLength)

    await db.destroy()
  })

  it('is idempotent: a second run over the same FS state writes nothing and warns nothing', async () => {
    const db = await memoryDb()
    expect((await migratorFor(db).migrateTo(BEFORE)).error).toBeUndefined()
    await seedWorkspace(db, 'ws-1')
    const bytes = snapshotBytes('idempotent content')
    await writeBlob(dataDir, 'ws-1', 'doc-c', bytes)

    expect((await migratorFor(db).migrateTo(THIS_ONE)).error).toBeUndefined()
    const afterFirst = await reassembledRow(db, 'canvas:doc-c')

    const capture = captureLogsForTests()
    try {
      // Mutation check: divergence keyed on row-existence (rather than byte
      // inequality) would warn here every time, since a row now exists.
      // This file migrates only as far as 0011, so its rows are the ones the
      // migration recorded — the prefix has to match that world, not the live
      // one. prepare.test.ts covers the boot path, which passes the live prefix.
      await importFsBlobs(db as unknown as Parameters<typeof importFsBlobs>[0], dataDir, 'canvas:')
      expect(capture.records).toHaveLength(0)
    } finally {
      capture.restore()
    }

    const afterSecond = await reassembledRow(db, 'canvas:doc-c')
    expect(afterSecond).toEqual(afterFirst)

    await db.destroy()
  })

  it('skips a zero-byte and a garbage-bytes blob without aborting the rest of the import', async () => {
    const db = await memoryDb()
    expect((await migratorFor(db).migrateTo(BEFORE)).error).toBeUndefined()
    await seedWorkspace(db, 'ws-1')

    await writeBlob(dataDir, 'ws-1', 'doc-empty', new Uint8Array(0))
    await writeBlob(dataDir, 'ws-1', 'doc-garbage', new Uint8Array([1, 2, 3, 4, 5]))
    const validBytes = snapshotBytes('the survivor')
    await writeBlob(dataDir, 'ws-1', 'doc-valid', validBytes)

    const capture = captureLogsForTests()
    try {
      expect((await migratorFor(db).migrateTo(THIS_ONE)).error).toBeUndefined()
      expect(capture.records.filter((r) => r.level === 'warning')).toHaveLength(2)
    } finally {
      capture.restore()
    }

    expect(await reassembledRow(db, 'canvas:doc-empty')).toBeNull()
    expect(await reassembledRow(db, 'canvas:doc-garbage')).toBeNull()
    expect(await reassembledRow(db, 'canvas:doc-valid')).toEqual(validBytes)

    await db.destroy()
  })

  it('does not abort the whole import when an existing row is structurally inconsistent with its manifest', async () => {
    const db = await memoryDb()
    expect((await migratorFor(db).migrateTo(BEFORE)).error).toBeUndefined()
    await seedWorkspace(db, 'ws-1')

    // A documentSnapshots row claiming 2 chunks but only 1 persisted — the
    // shape a prior interrupted importOneBlob call would leave, since its
    // two inserts are not wrapped in a shared sub-transaction.
    await db
      .insertInto('documentSnapshots')
      .values({
        docKey: 'canvas:doc-broken',
        chunkCount: 2,
        totalBytes: 10,
        maxChunkBytes: 5,
        frontier: new Uint8Array([9]),
      })
      .execute()
    await db
      .insertInto('documentSnapshotChunks')
      .values({
        docKey: 'canvas:doc-broken',
        chunkIndex: 0,
        bytes: new Uint8Array([1, 2, 3, 4, 5]),
      })
      .execute()

    await writeBlob(dataDir, 'ws-1', 'doc-broken', snapshotBytes('anything'))
    const okBytes = snapshotBytes('the sibling document')
    await writeBlob(dataDir, 'ws-1', 'doc-ok', okBytes)

    const capture = captureLogsForTests()
    try {
      expect((await migratorFor(db).migrateTo(THIS_ONE)).error).toBeUndefined()
      const warnings = capture.records.filter(
        (r) => r.level === 'warning' && r.data?.documentId === 'doc-broken',
      )
      expect(warnings).toHaveLength(1)
    } finally {
      capture.restore()
    }

    // The broken row itself is left untouched...
    const header = await db
      .selectFrom('documentSnapshots')
      .select(['chunkCount'])
      .where('docKey', '=', 'canvas:doc-broken')
      .executeTakeFirstOrThrow()
    expect(header.chunkCount).toBe(2)
    // ...but the sibling document still imports.
    expect(await reassembledRow(db, 'canvas:doc-ok')).toEqual(okBytes)

    await db.destroy()
  })

  it('runs the standalone importFsBlobs a second time against an already-migrated database to catch a later-written blob', async () => {
    const db = await memoryDb()
    expect((await migratorFor(db).migrateToLatest()).error).toBeUndefined()
    await seedWorkspace(db, 'ws-1')

    // Written AFTER the migration already ran and recorded its key —
    // simulating the interim-window gap the flip slice closes.
    const lateBytes = snapshotBytes('written after migration ran')
    await writeBlob(dataDir, 'ws-1', 'doc-late', lateBytes)

    await importFsBlobs(db as unknown as Parameters<typeof importFsBlobs>[0], dataDir, 'canvas:')

    const reassembled = await reassembledRow(db, 'canvas:doc-late')
    expect(reassembled).toEqual(lateBytes)

    await db.destroy()
  })

  it('is a clean no-op over a data dir with no blobs directory at all', async () => {
    const db = await memoryDb()
    expect((await migratorFor(db).migrateTo(BEFORE)).error).toBeUndefined()

    const result = await migratorFor(db).migrateTo(THIS_ONE)
    expect(result.error).toBeUndefined()

    await db.destroy()
  })

  it('ignores non-.loro files and a stray file sitting directly under blobs/', async () => {
    const db = await memoryDb()
    expect((await migratorFor(db).migrateTo(BEFORE)).error).toBeUndefined()
    await seedWorkspace(db, 'ws-1')

    const canvasDir = join(dataDir, 'blobs', 'ws-1', 'canvas')
    await mkdir(canvasDir, { recursive: true })
    await writeFile(join(canvasDir, 'notes.txt'), 'not a snapshot')
    await writeFile(join(dataDir, 'blobs', 'stray-file'), 'not a workspace dir')

    expect((await migratorFor(db).migrateTo(THIS_ONE)).error).toBeUndefined()

    const rows = await db.selectFrom('documentSnapshots').selectAll().execute()
    expect(rows).toEqual([])

    await db.destroy()
  })

  // Skipped where this process cannot be denied read access to its own
  // files -- root, or a filesystem that ignores the mode. `shared/test-utils/can-deny-file-read.ts`
  // PROBES that rather than inferring it from the uid, and says why.
  it.skipIf(!CAN_DENY_FILE_READ)(
    'warns and skips a blob that fails to read (e.g. permission denied) without aborting the rest of the import',
    async () => {
      const db = await memoryDb()
      expect((await migratorFor(db).migrateTo(BEFORE)).error).toBeUndefined()
      await seedWorkspace(db, 'ws-1')

      const unreadablePath = await writeBlob(dataDir, 'ws-1', 'doc-unreadable', snapshotBytes('x'))
      const { chmod } = await import('node:fs/promises')
      await chmod(unreadablePath, 0o000)

      const okBytes = snapshotBytes('the sibling document')
      await writeBlob(dataDir, 'ws-1', 'doc-ok', okBytes)

      const capture = captureLogsForTests()
      try {
        expect((await migratorFor(db).migrateTo(THIS_ONE)).error).toBeUndefined()
        const warnings = capture.records.filter(
          (r) => r.level === 'warning' && r.data?.documentId === 'doc-unreadable',
        )
        expect(warnings).toHaveLength(1)
      } finally {
        capture.restore()
        await chmod(unreadablePath, 0o644)
      }

      expect(await reassembledRow(db, 'canvas:doc-unreadable')).toBeNull()
      expect(await reassembledRow(db, 'canvas:doc-ok')).toEqual(okBytes)

      await db.destroy()
    },
  )

  it('backfills a missing documentFrontiers row when the snapshot+chunks pair already matches the FS blob', async () => {
    const db = await memoryDb()
    expect((await migratorFor(db).migrateTo(BEFORE)).error).toBeUndefined()
    await seedWorkspace(db, 'ws-1')

    // The shape a prior importOneBlob call would leave if interrupted AFTER
    // its documentSnapshots/documentSnapshotChunks inserts but BEFORE its
    // documentFrontiers insert: bytes fully present, frontier row missing.
    const bytes = snapshotBytes('interrupted before the frontier insert')
    const { manifest, chunks } = chunkSnapshot(bytes, 1_000_000)
    await db
      .insertInto('documentSnapshots')
      .values({
        docKey: 'canvas:doc-partial',
        chunkCount: manifest.chunkCount,
        totalBytes: manifest.totalBytes,
        maxChunkBytes: manifest.maxChunkBytes,
        frontier: new Uint8Array([9]),
      })
      .execute()
    await db
      .insertInto('documentSnapshotChunks')
      .values(
        chunks.map((c) => ({ docKey: 'canvas:doc-partial', chunkIndex: c.index, bytes: c.bytes })),
      )
      .execute()

    await writeBlob(dataDir, 'ws-1', 'doc-partial', bytes)

    const capture = captureLogsForTests()
    try {
      expect((await migratorFor(db).migrateTo(THIS_ONE)).error).toBeUndefined()
      expect(capture.records).toHaveLength(0)
    } finally {
      capture.restore()
    }

    const frontierRow = await db
      .selectFrom('documentFrontiers')
      .select('frontier')
      .where('docKey', '=', 'canvas:doc-partial')
      .executeTakeFirstOrThrow()
    const frontier =
      frontierRow.frontier instanceof Uint8Array
        ? frontierRow.frontier
        : new Uint8Array(frontierRow.frontier)
    expect(frontier).toEqual(expectedFrontier(bytes))

    await db.destroy()
  })

  // Skipped where this process cannot be denied read access to its own
  // files -- root, or a filesystem that ignores the mode. `shared/test-utils/can-deny-file-read.ts`
  // PROBES that rather than inferring it from the uid, and says why.
  it.skipIf(!CAN_DENY_FILE_READ)(
    'rethrows an unexpected readdir error (e.g. permission denied on a canvas directory) so the whole migration aborts',
    async () => {
      const db = await memoryDb()
      expect((await migratorFor(db).migrateTo(BEFORE)).error).toBeUndefined()
      await seedWorkspace(db, 'ws-1')

      const canvasDir = join(dataDir, 'blobs', 'ws-1', 'canvas')
      await writeBlob(dataDir, 'ws-1', 'doc-a', snapshotBytes('unreachable'))
      const { chmod } = await import('node:fs/promises')
      await chmod(canvasDir, 0o000)

      try {
        const result = await migratorFor(db).migrateTo(THIS_ONE)
        expect(result.error).toBeInstanceOf(Error)
        expect((result.error as NodeJS.ErrnoException).code).toBe('EACCES')
      } finally {
        await chmod(canvasDir, 0o755)
      }

      await db.destroy()
    },
  )

  it('exports the migration object wrapping the same routine', () => {
    expect(typeof migration.up).toBe('function')
    expect(typeof migration.down).toBe('function')
  })
})
