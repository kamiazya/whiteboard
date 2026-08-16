import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { documentEntrySchema } from '@kamiazya/whiteboard-ports'
import { describeDocumentIndexConformance } from '@kamiazya/whiteboard-ports/test-utils'
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
    // `saveDocument` minted nanoid row ids before the id spaces converged, and
    // rows outlive minting policy. One such row per workspace was enough to
    // make every entry unreadable: the port's DocumentEntry accepts only a
    // canonical ULID documentId, so a listing that mapped the legacy row blew
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
        .insertInto('documents')
        .values({
          id: 'Go1G4OcJKUBu',
          workspaceId: 'ws1',
          path: 'legacy-row',
          kind: 'spatial',
          createdAt: Date.now(),
          updatedAt: Date.now(),
        })
        .execute()

      const entries = await index.listDocuments({ workspaceId: 'ws1' })
      expect(entries.map((e) => e.documentId)).toEqual([created.documentId])
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
  // validates at runtime, so ONE of them once made the whole listing fail
  // rather than degrading (the #795 regression). These pin the resolution.
  async function withLegacyRow(body: (index: SqliteDocumentIndex) => Promise<void>): Promise<void> {
    const tempDir = await mkdtemp(join(tmpdir(), 'whiteboard-legacy-id-'))
    const handle = await createIsolatedDb({ dataDir: tempDir })
    try {
      await handle.db
        .insertInto('workspaces')
        .values({ id: 'ws-legacy', createdAt: 0, updatedAt: 0 })
        .execute()
      await handle.db
        .insertInto('documents')
        .values({
          id: 'uH6qTx6Ai2hl',
          workspaceId: 'ws-legacy',
          path: 'pre-ulid-doc',
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

  // #801 closed the gap this guarded (it was an `it.fails` for one merge):
  // listDocuments now skips a non-ULID row instead of emitting an entry the
  // port schema rejects, so every entry it does emit is valid.
  it('does not emit a listing entry that fails its own schema', async () => {
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

  it('skips the legacy row rather than failing the listing — the #801 contract', async () => {
    // Two candidate designs met here and this pins the one that won. #802
    // wanted the row accounted for in the listing; #801 skips it with a
    // warning log, and its rationale holds: these rows were never in the
    // agent listing before the convergence either (the retired tree did not
    // hold them), so skipping restores the status quo ante rather than
    // hiding something previously visible — and the row stays reachable in
    // the user's gallery. What must never come back is the failure mode both
    // PRs were about: one legacy row darkening the whole listing.
    await withLegacyRow(async (index) => {
      const entries = await index.listDocuments({ workspaceId: 'ws-legacy' })
      expect(entries.map((entry) => entry.path)).not.toContain('pre-ulid-doc')
    })
  })
})

describe('rows written before documents had a kind', () => {
  // A document created before `kind` existed has bytes on disk and a row in
  // `canvases`, but kind IS NULL. Hiding it from every listing while its
  // content sits on disk is the same dishonest surface a 200-empty workspace
  // was: the row must surface — without a kind — and the READ path is where
  // "format unknown" is said (wb_document_get already refuses one with
  // advice, rather than the listing pretending it does not exist).
  async function withKindlessRow(
    body: (index: SqliteDocumentIndex, documentId: string) => Promise<void>,
  ): Promise<void> {
    const tempDir = await mkdtemp(join(tmpdir(), 'whiteboard-kindless-'))
    const handle = await createIsolatedDb({ dataDir: tempDir })
    const documentId = '01ARZ3NDEKTSV4RRFFQ69G5FAV'
    try {
      await handle.db
        .insertInto('workspaces')
        .values({ id: 'ws-k', createdAt: 0, updatedAt: 0 })
        .execute()
      await handle.db
        .insertInto('documents')
        .values({
          id: documentId,
          workspaceId: 'ws-k',
          path: 'pre-kind-doc',
          displayName: 'Old diagram',
          isPinned: 0,
          pinOrder: null,
          currentBranch: 'main',
          createdAt: 0,
          updatedAt: 0,
          kind: null,
        })
        .execute()
      await body(new SqliteDocumentIndex(handle.db), documentId)
    } finally {
      await handle.dispose()
      await rm(tempDir, { recursive: true, force: true })
    }
  }

  it('lists the document, without a kind, and the entry satisfies the schema', async () => {
    await withKindlessRow(async (index) => {
      const entries = await index.listDocuments({ workspaceId: 'ws-k' })
      expect(entries.map((entry) => entry.path)).toContain('pre-kind-doc')
      const entry = entries.find((candidate) => candidate.path === 'pre-kind-doc')
      expect(entry?.kind).toBeUndefined()
      expect(entry?.name).toBe('Old diagram')
      expect(documentEntrySchema.safeParse(entry).success).toBe(true)
    })
  })

  it('resolves the document by id and by path', async () => {
    await withKindlessRow(async (index, documentId) => {
      const byId = await index.resolveDocumentById({ workspaceId: 'ws-k', documentId })
      expect(byId?.path).toBe('pre-kind-doc')
      expect(byId?.kind).toBeUndefined()

      const byPath = await index.resolveDocument({ workspaceId: 'ws-k', path: 'pre-kind-doc' })
      expect(byPath?.documentId).toBe(documentId)
    })
  })
})
