import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
