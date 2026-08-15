import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { documentEntrySchema } from '@kamiazya/whiteboard-canvas-ports'
import { describeDocumentIndexConformance } from '@kamiazya/whiteboard-canvas-ports/test-utils'
import { describe, expect, it } from 'vitest'
import { createIsolatedDb } from './db/test-helpers.js'
import { SqliteDocumentIndex } from './sqlite-document-index.js'

describe('SqliteDocumentIndex', () => {
  describeDocumentIndexConformance(async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'whiteboard-document-index-'))
    const handle = await createIsolatedDb({ dataDir: tempDir })
    return {
      index: new SqliteDocumentIndex(handle.db),
      dispose: async () => {
        await handle.dispose()
        await rm(tempDir, { recursive: true, force: true })
      },
    }
  })

  it('lists past a legacy nanoid row instead of letting it poison the whole listing', async () => {
    // `saveCanvas` minted nanoid row ids before the id spaces converged, and
    // rows outlive minting policy. One such row per workspace was enough to
    // make every entry unreadable: the port's DocumentEntry accepts only a
    // canonical ULID canvasId, so a listing that mapped the legacy row blew
    // up output validation for the ENTIRE list — the agent surface went dark
    // over a row it could never have created. The honest degradation is the
    // one these rows always had: visible to the user's gallery, absent from
    // the agent surface, and said in a log rather than an abort.
    const tempDir = await mkdtemp(join(tmpdir(), 'whiteboard-document-index-legacy-'))
    const handle = await createIsolatedDb({ dataDir: tempDir })
    try {
      const index = new SqliteDocumentIndex(handle.db)
      await index.createWorkspace({ workspaceId: 'ws1' })
      const created = await index.createDocument({
        workspaceId: 'ws1',
        path: 'modern',
        kind: 'spatial',
      })
      await handle.db
        .insertInto('canvases')
        .values({
          id: 'Go1G4OcJKUBu',
          workspaceId: 'ws1',
          slug: 'legacy-row',
          kind: 'spatial',
          createdAt: Date.now(),
          updatedAt: Date.now(),
        })
        .execute()

      const entries = await index.listDocuments({ workspaceId: 'ws1' })
      expect(entries.map((e) => e.canvasId)).toEqual([created.canvasId])
    } finally {
      await handle.dispose()
      await rm(tempDir, { recursive: true, force: true })
    }
  })
})

describe('rows written before canvasIds were ULIDs', () => {
  // A daemon that predates ADR-0007 decision 5 has nanoid ids in `canvases`.
  // The index reads that table directly now, so such a row reaches every
  // caller — and `wb_document_list` declares an outputSchema the MCP SDK
  // validates at runtime, so ONE of them makes the whole listing fail rather
  // than degrading. The index must not hand out an entry that violates the
  // schema its own port declares.
  async function withLegacyRow(body: (index: SqliteDocumentIndex) => Promise<void>): Promise<void> {
    const tempDir = await mkdtemp(join(tmpdir(), 'whiteboard-legacy-id-'))
    const handle = await createIsolatedDb({ dataDir: tempDir })
    try {
      await handle.db
        .insertInto('workspaces')
        .values({ id: 'ws-legacy', createdAt: 0, updatedAt: 0 })
        .execute()
      await handle.db
        .insertInto('canvases')
        .values({
          id: 'uH6qTx6Ai2hl',
          workspaceId: 'ws-legacy',
          slug: 'pre-ulid-doc',
          displayName: null,
          isPinned: 0,
          pinOrder: null,
          currentBranch: 'main',
          createdAt: 0,
          updatedAt: 0,
          kind: 'spatial',
        })
        .execute()
      await body(new SqliteDocumentIndex(handle.db))
    } finally {
      await handle.dispose()
      await rm(tempDir, { recursive: true, force: true })
    }
  }

  // KNOWN GAP, deliberately not fixed here (user decision 2026-08-15): the
  // product keeps emitting the offending entry, and the affected local data
  // was repaired by hand instead. `it.fails` is the guard — it passes while
  // the gap is open and turns RED the moment someone closes it, which forces
  // whoever does to come here and flip it rather than leaving a stale test.
  // The fix is a migration that rewrites pre-ULID ids and moves the blobs and
  // every table that references them; see the task for the surface.
  it.fails('does not emit a listing entry that fails its own schema', async () => {
    await withLegacyRow(async (index) => {
      const entries = await index.listDocuments({ workspaceId: 'ws-legacy' })
      for (const entry of entries) {
        expect(
          documentEntrySchema.safeParse(entry).success,
          `entry violates documentEntrySchema: ${JSON.stringify(entry)}`,
        ).toBe(true)
      }
    })
  })

  it('still accounts for the document rather than silently dropping it', async () => {
    // Whatever the fix, the row must not just vanish: a listing that quietly
    // omits stored data is the same dishonest surface a 200-empty was.
    await withLegacyRow(async (index) => {
      const entries = await index.listDocuments({ workspaceId: 'ws-legacy' })
      expect(entries.map((entry) => entry.path)).toContain('pre-ulid-doc')
    })
  })
})
