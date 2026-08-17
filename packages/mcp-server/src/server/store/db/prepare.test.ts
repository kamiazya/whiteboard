// Deploy-sequencing guard for the identity-convergence flip: migration 0011
// runs its FS-blob import exactly once (Kysely tracks migrations by key), so
// a blob written by an old process AFTER that one-time run — but before this
// flip's dataDir is fully warmed up again — would be invisible to the
// flipped, Libsql-only read path unless prepareDataDir re-invokes the same
// import routine on every call.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generateDocumentId } from '@kamiazya/whiteboard-model'
import { reassembleSnapshot } from '@kamiazya/whiteboard-ports'
import { LoroDoc } from 'loro-crdt'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LibsqlDocumentStore } from '../libsql/libsql-document-store.js'
import { closeDb, getDb } from './index.js'
import { clearPrepareCache, prepareDataDir } from './prepare.js'

let tempDir: string

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'whiteboard-prepare-test-'))
})

afterEach(async () => {
  await closeDb(tempDir)
  clearPrepareCache()
  await rm(tempDir, { recursive: true, force: true })
})

describe('prepareDataDir', () => {
  it('re-runs the FS-blob import on every call, closing the interim window between a fresh boot and the flip serving reads', async () => {
    // First boot: migrations (including 0011's one-time tracked run) apply
    // to an otherwise-empty dataDir.
    await prepareDataDir(tempDir)
    const db = await getDb(tempDir)

    const workspaceId = 'ws-interim'
    const documentId = generateDocumentId()
    const now = Date.now()
    await db
      .insertInto('workspaces')
      .values({ id: workspaceId, displayName: null, createdAt: now, updatedAt: now })
      .execute()
    await db
      .insertInto('documents')
      .values({
        id: documentId,
        workspaceId,
        path: 'interim-doc',
        displayName: null,
        isPinned: 0,
        pinOrder: null,
        currentBranch: 'main',
        createdAt: now,
        updatedAt: now,
        kind: null,
      })
      .execute()

    // Simulate an FS-only blob written by an old (pre-flip) process during
    // the window between 0011's first tracked run and this flip taking over
    // the read path.
    const doc = new LoroDoc()
    doc.getText('content').insert(0, 'written during the interim window')
    doc.commit()
    const blobDir = join(tempDir, 'blobs', workspaceId, 'canvas')
    await mkdir(blobDir, { recursive: true })
    await writeFile(join(blobDir, `${documentId}.loro`), doc.export({ mode: 'snapshot' }))

    const libsqlStore = new LibsqlDocumentStore(db)
    const docRef = { kind: 'canvas' as const, documentId }
    // Nothing has imported the interim blob yet.
    await expect(libsqlStore.loadSnapshot({ docRef })).resolves.toBeNull()

    // Second boot: a fresh prepareDataDir call, exactly like every daemon
    // startup makes against the same dataDir.
    clearPrepareCache()
    await prepareDataDir(tempDir)

    const imported = await libsqlStore.loadSnapshot({ docRef })
    expect(imported).not.toBeNull()
    const reloaded = new LoroDoc()
    reloaded.import(reassembleSnapshot(imported!.manifest, imported!.chunks))
    expect(reloaded.getText('content').toString()).toBe('written during the interim window')
  })
})
