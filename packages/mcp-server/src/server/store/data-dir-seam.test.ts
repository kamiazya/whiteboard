// Locks the contract that the storage layer follows the *effective* data
// dir (getDataDir()) rather than the import-time DATA_DIR snapshot. This is
// what makes `whiteboard daemon run --data-dir=<path>` actually isolate
// canvas/DB storage instead of only relocating the daemon registry file.
//
// Deliberately NO vi.mock of config.js here: the point is to prove the real
// modules re-read the seam. WHITEBOARD_DATA_DIR is pinned to a scratch dir
// BEFORE the store modules load so the frozen DATA_DIR snapshot can never
// point at the developer's real home directory even while the test is red.
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LoroDoc } from 'loro-crdt'
import { afterAll, afterEach, describe, expect, it } from 'vitest'

const importBaseDir = mkdtempSync(join(tmpdir(), 'whiteboard-seam-base-'))
process.env.WHITEBOARD_DATA_DIR = importBaseDir

// lazy-import: WHITEBOARD_DATA_DIR above has to be set BEFORE these modules
// evaluate — a static import is hoisted above it and would freeze the
// DATA_DIR snapshot at the developer's real home directory, which is exactly
// what this test exists to prove cannot happen.
const { overrideDataDir, resetDataDirForTests } = await import('../../shared/data-dir-secure.js')
const { saveDocument, resolveDocumentIdAtPath } = await import('./document-store.js')
const { closeDb, getDb } = await import('./db/index.js')

describe('storage layer follows the effective data dir seam', () => {
  let overrideDir: string

  afterEach(async () => {
    resetDataDirForTests()
    await closeDb()
    if (overrideDir) rmSync(overrideDir, { recursive: true, force: true })
  })

  afterAll(() => {
    rmSync(importBaseDir, { recursive: true, force: true })
  })

  it('persists canvas snapshots and the sqlite db under an overridden data dir, not the import-time snapshot', async () => {
    overrideDir = mkdtempSync(join(tmpdir(), 'whiteboard-seam-override-'))
    overrideDataDir(overrideDir)

    const doc = new LoroDoc()
    doc.getMap('root').set('k', 'v')
    doc.commit()
    await saveDocument('ws-seam-test', 'seam-canvas', doc)

    const overrideEntries = await readdir(overrideDir)
    expect(overrideEntries).toContain('whiteboard.db')

    // Canvas content lives in the sqlite db's Libsql snapshot tables now —
    // in the WORKSPACE record — confirm the row landed under the override
    // dir's db, keyed to the workspace just saved into.
    const db = await getDb(overrideDir)
    const documentId = await resolveDocumentIdAtPath('ws-seam-test', 'seam-canvas')
    expect(documentId).not.toBeNull()
    const snapshotRow = await db
      .selectFrom('documentSnapshots')
      .select(['docKey'])
      .where('docKey', '=', 'workspace-tree:ws-seam-test')
      .executeTakeFirst()
    expect(snapshotRow).toBeDefined()

    // The import-time snapshot dir must stay untouched by canvas persistence.
    expect(existsSync(join(importBaseDir, 'whiteboard.db'))).toBe(false)
  })
})
