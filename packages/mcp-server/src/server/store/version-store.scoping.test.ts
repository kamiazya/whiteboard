import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { LoroDoc } from 'loro-crdt'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeSpatialDoc } from '../../shared/test-utils/spatial-doc.js'

// What a version lookup may answer for a DIFFERENT workspace, and which end of
// a document's history each judgement reads. Two workspaces hold a document at
// the same path, so every id and every row has a plausible wrong owner.

let tempDir: string

vi.mock('../config.js', () => ({
  get DATA_DIR() {
    return tempDir
  },
  getDataDir: () => tempDir,
  WHITEBOARD_ROOT: '/tmp',
  REPO_ROOT: '/tmp',
}))

const { FileVersionStore } = await import('./version-store.js')
const { saveDocument } = await import('./document-store.js')
const { frontiersToBase64 } = await import('@kamiazya/whiteboard-history')

function canvasOf(text: string): SpatialCanvas {
  return { nodes: [textNode({ id: 'n', text, x: 0, y: 0, width: 100, height: 40 })], edges: [] }
}

const edit = (workspaceId: string, text: string) =>
  saveDocument(workspaceId, 'doc', makeSpatialDoc(canvasOf(text)), {
    kind: 'spatial',
    overwrite: true,
  })

/** Run `fn` with the clock pinned, so two saves are ordered by time and not by luck. */
async function at<T>(tMs: number, fn: () => Promise<T>): Promise<T> {
  const spy = vi.spyOn(Date, 'now').mockImplementation(() => tMs)
  try {
    return await fn()
  } finally {
    spy.mockRestore()
  }
}

describe('FileVersionStore workspace scoping and ordering', () => {
  let store: InstanceType<typeof FileVersionStore>
  let handle: Awaited<ReturnType<typeof import('./db/test-helpers.js').createIsolatedDb>>

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'version-scoping-'))
    const { createIsolatedDb } = await import('./db/test-helpers.js')
    handle = await createIsolatedDb({ dataDir: tempDir })
    store = new FileVersionStore()
    await saveDocument('ws-a', 'doc', new LoroDoc(), { kind: 'spatial' })
    await saveDocument('ws-b', 'doc', new LoroDoc(), { kind: 'spatial' })
  })

  afterEach(async () => {
    await handle.dispose()
    await rm(tempDir, { recursive: true, force: true })
  })

  describe('a version id that belongs to another workspace', () => {
    // Each reader is asked under the OTHER workspace's path with an id that
    // exists, so a lookup that forgot the workspace filter finds a real row.
    async function foreignVersionId(): Promise<string> {
      await edit('ws-b', 'b')
      return (await store.save('ws-b', 'doc', new LoroDoc(), { auto: false })).id
    }

    it('is not answered as adopted into this workspace', async () => {
      // The caller learns a carried version did not arrive only by its id
      // being absent here; the row the insert skipped is the other workspace's.
      const id = await foreignVersionId()
      const kept = await store.adopt('ws-a', [
        {
          id,
          documentId: 'doc-a',
          createdAt: 1,
          auto: false,
          frontiers: [],
          elementCount: 0,
          contentDigest: 'x',
        },
      ])
      expect(kept).toEqual([])
    })

    it('is not listed by document id', async () => {
      const id = await foreignVersionId()
      const row = await handle.db
        .selectFrom('versions')
        .select(['documentId'])
        .where('id', '=', id)
        .executeTakeFirstOrThrow()
      expect(await store.listIdsByDocument('ws-b', row.documentId)).toContain(id)
      expect(await store.listIdsByDocument('ws-a', row.documentId)).toEqual([])
    })

    it("is not in this workspace's history under the same document id", async () => {
      await edit('ws-a', 'a')
      const saved = await store.save('ws-a', 'doc', new LoroDoc(), { auto: false })
      const own = await handle.db
        .selectFrom('versions')
        .selectAll()
        .where('id', '=', saved.id)
        .executeTakeFirstOrThrow()
      await handle.db
        .insertInto('versions')
        .values({ ...own, id: 'foreign-same-document', workspaceId: 'ws-b' })
        .execute()
      expect((await store.list('ws-a', 'doc')).map((entry) => entry.id)).toEqual([saved.id])
    })

    it('is not loaded', async () => {
      const id = await foreignVersionId()
      await expect(store.load('ws-a', id)).resolves.toBeNull()
    })

    it('is not loaded as a workspace record', async () => {
      const id = await foreignVersionId()
      await expect(store.loadWorkspaceAt('ws-a', id)).resolves.toBeNull()
    })

    it('is still served to its own workspace', async () => {
      const id = await foreignVersionId()
      await expect(store.loadWorkspaceAt('ws-b', id)).resolves.not.toBeNull()
      await expect(store.load('ws-b', id)).resolves.not.toBeNull()
    })
  })

  describe('the automatic-cap prune', () => {
    const autoRowCount = async (workspaceId: string): Promise<number> =>
      (
        await handle.db
          .selectFrom('versions')
          .select('id')
          .where('workspaceId', '=', workspaceId)
          .where('auto', '=', 1)
          .execute()
      ).length

    it("counts only this workspace's autos, never a neighbour's under the same document id", async () => {
      await edit('ws-a', 'one')
      await at(1_000, () => store.save('ws-a', 'doc', new LoroDoc(), { auto: true }))
      const own = await handle.db
        .selectFrom('versions')
        .selectAll()
        .where('workspaceId', '=', 'ws-a')
        .executeTakeFirstOrThrow()
      // Enough of the neighbour's to fill the cap on their own, all newer than
      // ws-a's first, so a cap counted across workspaces retires ws-a's.
      await handle.db
        .insertInto('versions')
        .values(
          Array.from({ length: 50 }, (_, i) => ({
            ...own,
            id: `foreign-${i}`,
            workspaceId: 'ws-b',
            createdAt: own.createdAt + 1_000 + i,
          })),
        )
        .execute()
      await edit('ws-a', 'two')
      await at(100_000, () => store.save('ws-a', 'doc', new LoroDoc(), { auto: true }))
      expect(await autoRowCount('ws-a')).toBe(2)
      expect(await autoRowCount('ws-b')).toBe(50)
    })

    it('holds the cap over the automatic rows a promote carries in', async () => {
      const rows = Array.from({ length: 51 }, (_, i) => ({
        id: `carried-${String(i).padStart(3, '0')}`,
        documentId: 'doc-a',
        createdAt: 1 + i,
        auto: true,
        frontiers: [],
        elementCount: 0,
        contentDigest: 'x',
      }))
      await store.adopt('ws-a', rows)
      expect(await autoRowCount('ws-a')).toBe(50)
    })
  })

  describe('pruneSandwichedAutoVersions', () => {
    async function saveAt(workspaceId: string, text: string, tMs: number, auto: boolean) {
      await edit(workspaceId, text)
      return at(tMs, () => store.save(workspaceId, 'doc', new LoroDoc(), { auto }))
    }
    const idsOf = async (workspaceId: string): Promise<string[]> =>
      (
        await handle.db
          .selectFrom('versions')
          .select('id')
          .where('workspaceId', '=', workspaceId)
          .orderBy('id')
          .execute()
      ).map((row) => row.id)

    it("does not bracket this workspace's autos with a neighbour's manual save", async () => {
      const manual = await saveAt('ws-a', 'one', 1_000, false)
      await saveAt('ws-a', 'two', 2_000, true)
      const own = await handle.db
        .selectFrom('versions')
        .selectAll()
        .where('id', '=', manual.id)
        .executeTakeFirstOrThrow()
      await handle.db
        .insertInto('versions')
        .values({
          ...own,
          id: 'foreign-manual',
          workspaceId: 'ws-b',
          createdAt: own.createdAt + 5_000,
        })
        .execute()
      const before = await idsOf('ws-a')
      expect(await store.pruneSandwichedAutoVersions('ws-a', 'doc')).toEqual({
        deletedCount: 0,
        deletedIds: [],
      })
      expect(await idsOf('ws-a')).toEqual(before)
    })

    it("leaves a neighbour's sandwiched autos under the same document id alone", async () => {
      const manual = await saveAt('ws-a', 'one', 1_000, false)
      const own = await handle.db
        .selectFrom('versions')
        .selectAll()
        .where('id', '=', manual.id)
        .executeTakeFirstOrThrow()
      const foreign = (id: string, auto: 0 | 1, dt: number) => ({
        ...own,
        id,
        auto,
        workspaceId: 'ws-b',
        createdAt: own.createdAt + dt,
      })
      await handle.db
        .insertInto('versions')
        .values([
          foreign('foreign-1', 0, 1_000),
          foreign('foreign-2', 1, 2_000),
          foreign('foreign-3', 0, 3_000),
        ])
        .execute()
      await store.pruneSandwichedAutoVersions('ws-a', 'doc')
      expect(await idsOf('ws-b')).toEqual(['foreign-1', 'foreign-2', 'foreign-3'])
    })
  })

  describe('adopt', () => {
    it('keeps the element count the carried version was judged with', async () => {
      const kept = await store.adopt('ws-a', [
        {
          id: 'carried-board',
          documentId: 'doc-a',
          createdAt: 1,
          auto: false,
          frontiers: [],
          elementCount: 2,
          contentDigest: 'x',
        },
      ])
      expect(kept).toEqual(['carried-board'])
      const row = await handle.db
        .selectFrom('versions')
        .select(['elementCount'])
        .where('id', '=', 'carried-board')
        .executeTakeFirstOrThrow()
      expect(row.elementCount).toBe(2)
    })
  })

  describe('isUnchangedSinceLastVersion', () => {
    async function checkpoint(workspaceId: string, text: string, tMs: number): Promise<void> {
      await edit(workspaceId, text)
      await at(tMs, () => store.save(workspaceId, 'doc', new LoroDoc(), { auto: true }))
    }

    it('judges the document against its NEWEST version', async () => {
      await checkpoint('ws-a', 'one', 1_000)
      await checkpoint('ws-a', 'two', 2_000)
      expect(await store.isUnchangedSinceLastVersion('ws-a', 'doc')).toBe(true)
    })

    it('reports a change when the content has gone back to an OLDER version', async () => {
      await checkpoint('ws-a', 'one', 1_000)
      await checkpoint('ws-a', 'two', 2_000)
      await edit('ws-a', 'one')
      expect(await store.isUnchangedSinceLastVersion('ws-a', 'doc')).toBe(false)
    })

    it('ignores a newer row another workspace holds for the same document id', async () => {
      await checkpoint('ws-a', 'one', 1_000)
      const own = await handle.db
        .selectFrom('versions')
        .selectAll()
        .where('workspaceId', '=', 'ws-a')
        .executeTakeFirstOrThrow()
      await handle.db
        .insertInto('versions')
        .values({
          ...own,
          id: 'foreign-row',
          workspaceId: 'ws-b',
          contentDigest: 'a-digest-no-document-has',
          createdAt: own.createdAt + 1_000,
        })
        .execute()
      expect(await store.isUnchangedSinceLastVersion('ws-a', 'doc')).toBe(true)
    })
  })

  describe('workspaceVersionFrontiers', () => {
    // The stored column, read straight off the row: it is the encoding the
    // store's answer has to agree with.
    async function frontiersOf(id: string): Promise<string | undefined> {
      const row = await handle.db
        .selectFrom('versions')
        .select('frontiers')
        .where('id', '=', id)
        .executeTakeFirst()
      return row?.frontiers
    }

    it("is every version's point in this workspace, however old another workspace's are", async () => {
      await edit('ws-b', 'b')
      await at(500, () => store.save('ws-b', 'doc', new LoroDoc(), { auto: false }))
      await edit('ws-a', 'one')
      const first = await at(1_000, () => store.save('ws-a', 'doc', new LoroDoc(), { auto: false }))
      await edit('ws-a', 'two')
      const second = await at(2_000, () =>
        store.save('ws-a', 'doc', new LoroDoc(), { auto: false }),
      )

      const points = (await store.workspaceVersionFrontiers('ws-a')).map(frontiersToBase64)
      expect(points.sort()).toEqual(
        [await frontiersOf(first.id), await frontiersOf(second.id)].sort(),
      )
    })

    it('is empty for a workspace with no versions', async () => {
      await expect(store.workspaceVersionFrontiers('ws-a')).resolves.toEqual([])
    })
  })
})
