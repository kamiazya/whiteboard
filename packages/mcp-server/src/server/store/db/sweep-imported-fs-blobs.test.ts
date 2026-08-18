import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chunkSnapshot, reassembleSnapshot } from '@kamiazya/whiteboard-ports'
import { LoroDoc } from 'loro-crdt'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { captureLogsForTests } from '../../log.js'
import { DOCUMENT_DOC_KEY_PREFIX } from '../doc-ref-key.js'
import { closeDb, getDb } from './index.js'
import { importFsBlobs } from './migrations/0011-import-fs-blobs.js'
import { runMigrations } from './migrator.js'
import { sweepImportedFsBlobs } from './sweep-imported-fs-blobs.js'

// Partial mock so test (f) can force a single readFile rejection (the TOCTOU
// window sweepOneBlob's own catch guards) while every other call — used
// throughout this suite's setup helpers and by the production code under
// test — goes through untouched.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, readFile: vi.fn(actual.readFile) }
})

let tempDir: string

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'whiteboard-sweep-test-'))
})

afterEach(async () => {
  await closeDb(tempDir)
  await rm(tempDir, { recursive: true, force: true })
})

/** A real, decodable LoroDoc snapshot — sweep gates on `reassembleSnapshot`, not decodability, but this keeps blobs realistic. */
function snapshotBytes(text: string): Uint8Array {
  const doc = new LoroDoc()
  doc.getText('t').insert(0, text)
  doc.commit()
  return doc.export({ mode: 'snapshot' })
}

async function writeBlob(
  workspaceId: string,
  documentId: string,
  bytes: Uint8Array,
): Promise<string> {
  const dir = join(tempDir, 'blobs', workspaceId, 'canvas')
  await mkdir(dir, { recursive: true })
  const path = join(dir, `${documentId}.loro`)
  await writeFile(path, bytes)
  return path
}

async function seedWorkspace(db: Awaited<ReturnType<typeof getDb>>, workspaceId: string) {
  await db
    .insertInto('workspaces')
    .values({ id: workspaceId, displayName: null, createdAt: 0, updatedAt: 0 })
    .onConflict((oc) => oc.doNothing())
    .execute()
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

describe('sweepImportedFsBlobs', () => {
  it('(a) deletes a blob proven byte-identical to its Libsql row, leaving the row loadable', async () => {
    const db = await getDb(tempDir)
    await runMigrations(db)
    await seedWorkspace(db, 'ws-1')

    const bytes = snapshotBytes('hello sweep')
    const blobPath = await writeBlob('ws-1', 'doc-a', bytes)
    await importFsBlobs(
      db as unknown as Parameters<typeof importFsBlobs>[0],
      tempDir,
      DOCUMENT_DOC_KEY_PREFIX,
    )
    expect(await exists(blobPath)).toBe(true) // import never deletes

    await sweepImportedFsBlobs(db, tempDir)

    expect(await exists(blobPath)).toBe(false)

    const header = await db
      .selectFrom('documentSnapshots')
      .select(['chunkCount', 'totalBytes', 'maxChunkBytes'])
      .where('docKey', '=', `${DOCUMENT_DOC_KEY_PREFIX}doc-a`)
      .executeTakeFirstOrThrow()
    const chunkRows = await db
      .selectFrom('documentSnapshotChunks')
      .select(['chunkIndex', 'bytes'])
      .where('docKey', '=', `${DOCUMENT_DOC_KEY_PREFIX}doc-a`)
      .orderBy('chunkIndex', 'asc')
      .execute()
    const reassembled = reassembleSnapshot(
      header,
      chunkRows.map((row) => ({
        index: row.chunkIndex,
        of: header.chunkCount,
        bytes: row.bytes instanceof Uint8Array ? row.bytes : new Uint8Array(row.bytes),
      })),
    )
    expect(reassembled).toEqual(bytes)
  })

  it('(b) never sweeps a blob that diverges from an existing snapshot row, leaving importFsBlobs’s divergence warning intact', async () => {
    const db = await getDb(tempDir)
    await runMigrations(db)
    await seedWorkspace(db, 'ws-1')

    const existingBytes = snapshotBytes('existing content')
    const { manifest, chunks } = chunkSnapshot(existingBytes, 1_000_000)
    await db
      .insertInto('documentSnapshots')
      .values({
        docKey: `${DOCUMENT_DOC_KEY_PREFIX}doc-b`,
        chunkCount: manifest.chunkCount,
        totalBytes: manifest.totalBytes,
        maxChunkBytes: manifest.maxChunkBytes,
        frontier: new Uint8Array([9]),
      })
      .execute()
    await db
      .insertInto('documentSnapshotChunks')
      .values(
        chunks.map((c) => ({
          docKey: `${DOCUMENT_DOC_KEY_PREFIX}doc-b`,
          chunkIndex: c.index,
          bytes: c.bytes,
        })),
      )
      .execute()
    await db
      .insertInto('documentFrontiers')
      .values({ docKey: `${DOCUMENT_DOC_KEY_PREFIX}doc-b`, frontier: new Uint8Array([9]) })
      .execute()

    const divergentBytes = snapshotBytes('a totally different document')
    const blobPath = await writeBlob('ws-1', 'doc-b', divergentBytes)

    const capture = captureLogsForTests()
    try {
      await importFsBlobs(
        db as unknown as Parameters<typeof importFsBlobs>[0],
        tempDir,
        DOCUMENT_DOC_KEY_PREFIX,
      )
      const warnings = capture.records.filter(
        (r) => r.level === 'warning' && r.data?.documentId === 'doc-b',
      )
      expect(warnings).toHaveLength(1)

      await sweepImportedFsBlobs(db, tempDir)
    } finally {
      capture.restore()
    }

    expect(await exists(blobPath)).toBe(true)
  })

  it('(c) never sweeps a garbage/zero-byte blob that import skipped (no row exists)', async () => {
    const db = await getDb(tempDir)
    await runMigrations(db)
    await seedWorkspace(db, 'ws-1')

    const blobPath = await writeBlob('ws-1', 'doc-garbage', new Uint8Array([1, 2, 3]))
    const capture = captureLogsForTests()
    try {
      await importFsBlobs(
        db as unknown as Parameters<typeof importFsBlobs>[0],
        tempDir,
        DOCUMENT_DOC_KEY_PREFIX,
      )
    } finally {
      capture.restore()
    }

    await sweepImportedFsBlobs(db, tempDir)

    expect(await exists(blobPath)).toBe(true)
  })

  it("(c') never sweeps a byte-matched blob whose documentFrontiers backfill failed (undecodable bytes)", async () => {
    const db = await getDb(tempDir)
    await runMigrations(db)
    await seedWorkspace(db, 'ws-1')

    // A documentSnapshots+chunks pair that byte-matches the FS blob exactly,
    // but whose bytes are not a decodable LoroDoc snapshot — the shape left
    // behind when importFsBlobs's frontier backfill itself failed to decode.
    const garbage = new Uint8Array([9, 9, 9, 9, 9])
    const { manifest, chunks } = chunkSnapshot(garbage, 1_000_000)
    await db
      .insertInto('documentSnapshots')
      .values({
        docKey: `${DOCUMENT_DOC_KEY_PREFIX}doc-partial`,
        chunkCount: manifest.chunkCount,
        totalBytes: manifest.totalBytes,
        maxChunkBytes: manifest.maxChunkBytes,
        frontier: new Uint8Array([1]),
      })
      .execute()
    await db
      .insertInto('documentSnapshotChunks')
      .values(
        chunks.map((c) => ({
          docKey: `${DOCUMENT_DOC_KEY_PREFIX}doc-partial`,
          chunkIndex: c.index,
          bytes: c.bytes,
        })),
      )
      .execute()
    // Deliberately no documentFrontiers row.

    const blobPath = await writeBlob('ws-1', 'doc-partial', garbage)

    await sweepImportedFsBlobs(db, tempDir)

    expect(await exists(blobPath)).toBe(true)
  })

  it('(c’’) never sweeps a blob whose matched snapshot row has internally inconsistent chunks (reassembleSnapshot throws)', async () => {
    const db = await getDb(tempDir)
    await runMigrations(db)
    await seedWorkspace(db, 'ws-1')

    // A documentSnapshots header declaring 2 chunks, a documentFrontiers row
    // (so both of sweepOneBlob's row-existence gates pass), but only chunk
    // index 0 actually stored — reassembleSnapshot throws MISSING_CHUNK for
    // this shape, which is the catch branch under test.
    const bytes = snapshotBytes('inconsistent chunks')
    const { manifest, chunks } = chunkSnapshot(bytes, Math.ceil(bytes.byteLength / 2))
    expect(manifest.chunkCount).toBeGreaterThanOrEqual(2)
    await db
      .insertInto('documentSnapshots')
      .values({
        docKey: `${DOCUMENT_DOC_KEY_PREFIX}doc-inconsistent`,
        chunkCount: manifest.chunkCount,
        totalBytes: manifest.totalBytes,
        maxChunkBytes: manifest.maxChunkBytes,
        frontier: new Uint8Array([1]),
      })
      .execute()
    await db
      .insertInto('documentSnapshotChunks')
      .values({
        docKey: `${DOCUMENT_DOC_KEY_PREFIX}doc-inconsistent`,
        chunkIndex: chunks[0].index,
        bytes: chunks[0].bytes,
      })
      .execute()
    await db
      .insertInto('documentFrontiers')
      .values({
        docKey: `${DOCUMENT_DOC_KEY_PREFIX}doc-inconsistent`,
        frontier: new Uint8Array([1]),
      })
      .execute()

    const blobPath = await writeBlob('ws-1', 'doc-inconsistent', bytes)

    await expect(sweepImportedFsBlobs(db, tempDir)).resolves.toBeUndefined()

    expect(await exists(blobPath)).toBe(true)
  })

  it('(d) removes empty canvas/workspace dirs after sweeping, but keeps a workspace dir alive for a sibling versions/thumbnail file', async () => {
    const db = await getDb(tempDir)
    await runMigrations(db)
    await seedWorkspace(db, 'ws-1')
    await seedWorkspace(db, 'ws-2')

    const bytes = snapshotBytes('sole document')
    await writeBlob('ws-1', 'doc-only', bytes)
    await importFsBlobs(
      db as unknown as Parameters<typeof importFsBlobs>[0],
      tempDir,
      DOCUMENT_DOC_KEY_PREFIX,
    )

    // ws-2 has a thumbnail sibling that must keep its workspace dir alive.
    const bytes2 = snapshotBytes('other workspace document')
    await writeBlob('ws-2', 'doc-2', bytes2)
    await importFsBlobs(
      db as unknown as Parameters<typeof importFsBlobs>[0],
      tempDir,
      DOCUMENT_DOC_KEY_PREFIX,
    )
    const versionsDir = join(tempDir, 'blobs', 'ws-2', 'versions')
    await mkdir(versionsDir, { recursive: true })
    await writeFile(join(versionsDir, 'thumb.png'), new Uint8Array([1]))

    await sweepImportedFsBlobs(db, tempDir)

    expect(await exists(join(tempDir, 'blobs', 'ws-1', 'canvas'))).toBe(false)
    expect(await exists(join(tempDir, 'blobs', 'ws-1'))).toBe(false)
    expect(await exists(join(tempDir, 'blobs', 'ws-2', 'canvas'))).toBe(false)
    expect(await exists(join(tempDir, 'blobs', 'ws-2'))).toBe(true)
    expect(await exists(versionsDir)).toBe(true)
  })

  it('(f) tolerates a blob removed between listing and reading it (TOCTOU), leaving the row and file untouched', async () => {
    const db = await getDb(tempDir)
    await runMigrations(db)
    await seedWorkspace(db, 'ws-1')

    const bytes = snapshotBytes('raced away')
    const blobPath = await writeBlob('ws-1', 'doc-race', bytes)
    await importFsBlobs(
      db as unknown as Parameters<typeof importFsBlobs>[0],
      tempDir,
      DOCUMENT_DOC_KEY_PREFIX,
    )

    // Simulate a writer replacing/removing the blob after readDirSafe listed
    // it but before sweepOneBlob's readFile runs — the TOCTOU window the
    // module's own ponytail comment calls out. A mocked rejection (rather
    // than unlinking before the sweep starts) is what actually reaches this
    // branch: an unlink beforehand just makes readDirSafe skip the entry.
    vi.mocked(readFile).mockRejectedValueOnce(
      Object.assign(new Error('ENOENT simulated'), { code: 'ENOENT' }),
    )
    try {
      await expect(sweepImportedFsBlobs(db, tempDir)).resolves.toBeUndefined()
    } finally {
      vi.mocked(readFile).mockClear()
    }

    expect(await exists(blobPath)).toBe(true)
    const header = await db
      .selectFrom('documentSnapshots')
      .select(['chunkCount'])
      .where('docKey', '=', `${DOCUMENT_DOC_KEY_PREFIX}doc-race`)
      .executeTakeFirst()
    expect(header).toBeDefined()
  })

  it('(g) a replacement at the original name survives a leftover claim: restore never overwrites it', async () => {
    // The invariant the rename-then-verify protocol buys: once a candidate
    // is claimed under `.sweeping`, a writer that lands on the original
    // pathname owns that name. A crashed pass leaves the claim behind; the
    // next pass must drop the stale claim rather than rename it back over
    // the newer file. (Deterministic stand-in for the interleaving itself:
    // the same two files, in the same state, that the race produces.)
    const db = await getDb(tempDir)
    await runMigrations(db)
    await seedWorkspace(db, 'ws-1')

    const originalBytes = snapshotBytes('claimed by a crashed pass')
    const blobPath = await writeBlob('ws-1', 'doc-race', originalBytes)
    await importFsBlobs(
      db as unknown as Parameters<typeof importFsBlobs>[0],
      tempDir,
      DOCUMENT_DOC_KEY_PREFIX,
    )
    // Stage the crash: the candidate is claimed, and a writer has since
    // recreated the original name with different bytes.
    const claimedPath = `${blobPath}.sweeping`
    await writeFile(claimedPath, originalBytes)
    const replacement = snapshotBytes('written by an old process after the claim')
    await writeFile(blobPath, replacement)

    await sweepImportedFsBlobs(db, tempDir)

    expect(await exists(claimedPath)).toBe(false)
    expect(await exists(blobPath)).toBe(true)
    expect(new Uint8Array(await readFile(blobPath))).toEqual(replacement)
  })

  it('(g2) adopts a leftover claim back when the original name is free, so a crashed pass loses nothing', async () => {
    const db = await getDb(tempDir)
    await runMigrations(db)
    await seedWorkspace(db, 'ws-1')

    // A claim with no import proof: adopted back, then judged (and kept,
    // because no snapshot row exists for it).
    const dir = join(tempDir, 'blobs', 'ws-1', 'canvas')
    await mkdir(dir, { recursive: true })
    const blobPath = join(dir, 'doc-orphan.loro')
    const bytes = snapshotBytes('survivor of a crashed sweep')
    await writeFile(`${blobPath}.sweeping`, bytes)

    await sweepImportedFsBlobs(db, tempDir)

    expect(await exists(`${blobPath}.sweeping`)).toBe(false)
    expect(await exists(blobPath)).toBe(true)
    expect(new Uint8Array(await readFile(blobPath))).toEqual(bytes)
  })

  it('(e) a second sweep over an already-swept dataDir is a clean no-op', async () => {
    const db = await getDb(tempDir)
    await runMigrations(db)
    await seedWorkspace(db, 'ws-1')

    const bytes = snapshotBytes('sweep once')
    await writeBlob('ws-1', 'doc-a', bytes)
    await importFsBlobs(
      db as unknown as Parameters<typeof importFsBlobs>[0],
      tempDir,
      DOCUMENT_DOC_KEY_PREFIX,
    )
    await sweepImportedFsBlobs(db, tempDir)

    const capture = captureLogsForTests()
    try {
      await expect(sweepImportedFsBlobs(db, tempDir)).resolves.toBeUndefined()
      expect(capture.records).toHaveLength(0)
    } finally {
      capture.restore()
    }
  })
})
