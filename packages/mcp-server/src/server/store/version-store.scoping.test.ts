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
const { saveDocument, compactWorkspace, getWorkspaceDoc, _clearWorkspaceDocCacheForTests } =
  await import('./document-store.js')
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
    await saveDocument('01PAW75F73PVC402Y3V151KT6R', 'doc', new LoroDoc(), { kind: 'spatial' })
    await saveDocument('01ECWTM29HBA5A9MXS76EM7JHR', 'doc', new LoroDoc(), { kind: 'spatial' })
  })

  afterEach(async () => {
    await handle.dispose()
    await rm(tempDir, { recursive: true, force: true })
  })

  describe('a version id that belongs to another workspace', () => {
    // Each reader is asked under the OTHER workspace's path with an id that
    // exists, so a lookup that forgot the workspace filter finds a real row.
    async function foreignVersionId(): Promise<string> {
      await edit('01ECWTM29HBA5A9MXS76EM7JHR', 'b')
      return (await store.save('01ECWTM29HBA5A9MXS76EM7JHR', 'doc', new LoroDoc(), { auto: false }))
        .id
    }

    it('is not answered as adopted into this workspace', async () => {
      // The caller learns a carried version did not arrive only by its id
      // being absent here; the row the insert skipped is the other workspace's.
      const id = await foreignVersionId()
      const kept = await store.adopt('01PAW75F73PVC402Y3V151KT6R', [
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
      expect(await store.listIdsByDocument('01ECWTM29HBA5A9MXS76EM7JHR', row.documentId)).toContain(
        id,
      )
      expect(await store.listIdsByDocument('01PAW75F73PVC402Y3V151KT6R', row.documentId)).toEqual(
        [],
      )
    })

    it("is not in this workspace's history under the same document id", async () => {
      await edit('01PAW75F73PVC402Y3V151KT6R', 'a')
      const saved = await store.save('01PAW75F73PVC402Y3V151KT6R', 'doc', new LoroDoc(), {
        auto: false,
      })
      const own = await handle.db
        .selectFrom('versions')
        .selectAll()
        .where('id', '=', saved.id)
        .executeTakeFirstOrThrow()
      await handle.db
        .insertInto('versions')
        .values({ ...own, id: 'foreign-same-document', workspaceId: '01ECWTM29HBA5A9MXS76EM7JHR' })
        .execute()
      expect(
        (await store.list('01PAW75F73PVC402Y3V151KT6R', 'doc')).map((entry) => entry.id),
      ).toEqual([saved.id])
    })

    it('is not loaded', async () => {
      const id = await foreignVersionId()
      await expect(store.load('01PAW75F73PVC402Y3V151KT6R', id)).resolves.toBeNull()
    })

    it('is not loaded as a workspace record', async () => {
      const id = await foreignVersionId()
      await expect(store.loadWorkspaceAt('01PAW75F73PVC402Y3V151KT6R', id)).resolves.toBeNull()
    })

    it('is still served to its own workspace', async () => {
      const id = await foreignVersionId()
      await expect(store.loadWorkspaceAt('01ECWTM29HBA5A9MXS76EM7JHR', id)).resolves.not.toBeNull()
      await expect(store.load('01ECWTM29HBA5A9MXS76EM7JHR', id)).resolves.not.toBeNull()
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
      await edit('01PAW75F73PVC402Y3V151KT6R', 'one')
      await at(1_000, () =>
        store.save('01PAW75F73PVC402Y3V151KT6R', 'doc', new LoroDoc(), { auto: true }),
      )
      const own = await handle.db
        .selectFrom('versions')
        .selectAll()
        .where('workspaceId', '=', '01PAW75F73PVC402Y3V151KT6R')
        .executeTakeFirstOrThrow()
      // Enough of the neighbour's to fill the cap on their own, all newer than
      // ws-a's first, so a cap counted across workspaces retires ws-a's.
      await handle.db
        .insertInto('versions')
        .values(
          Array.from({ length: 50 }, (_, i) => ({
            ...own,
            id: `foreign-${i}`,
            workspaceId: '01ECWTM29HBA5A9MXS76EM7JHR',
            createdAt: own.createdAt + 1_000 + i,
          })),
        )
        .execute()
      await edit('01PAW75F73PVC402Y3V151KT6R', 'two')
      await at(100_000, () =>
        store.save('01PAW75F73PVC402Y3V151KT6R', 'doc', new LoroDoc(), { auto: true }),
      )
      expect(await autoRowCount('01PAW75F73PVC402Y3V151KT6R')).toBe(2)
      expect(await autoRowCount('01ECWTM29HBA5A9MXS76EM7JHR')).toBe(50)
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
      await store.adopt('01PAW75F73PVC402Y3V151KT6R', rows)
      expect(await autoRowCount('01PAW75F73PVC402Y3V151KT6R')).toBe(50)
    })

    it("makes room for carried automatic rows from the carried ones, never this keeper's own", async () => {
      const genuine: string[] = []
      for (let i = 0; i < 10; i++) {
        await edit('01PAW75F73PVC402Y3V151KT6R', `own-${i}`)
        genuine.push(
          (
            await at(1_000 + i, () =>
              store.save('01PAW75F73PVC402Y3V151KT6R', 'doc', new LoroDoc(), { auto: true }),
            )
          ).id,
        )
      }
      const { documentId } = await handle.db
        .selectFrom('versions')
        .select('documentId')
        .where('id', '=', genuine[0]!)
        .executeTakeFirstOrThrow()
      const now = Date.now()
      const carried = Array.from({ length: 50 }, (_, i) => ({
        id: `carried-${String(i).padStart(3, '0')}`,
        documentId,
        createdAt: now + i,
        auto: true,
        frontiers: [],
        elementCount: 0,
        contentDigest: 'x',
      }))
      // One carried row reuses an own row's id: the insert skips it, and it
      // must not become prunable by having been named.
      await store.adopt('01PAW75F73PVC402Y3V151KT6R', [
        ...carried,
        { ...carried[0]!, id: genuine[0]! },
      ])
      const kept = new Set(
        (
          await handle.db
            .selectFrom('versions')
            .select('id')
            .where('workspaceId', '=', '01PAW75F73PVC402Y3V151KT6R')
            .execute()
        ).map((row) => row.id),
      )
      expect(genuine.filter((id) => !kept.has(id))).toEqual([])
      expect(await autoRowCount('01PAW75F73PVC402Y3V151KT6R')).toBe(50)
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
      const manual = await saveAt('01PAW75F73PVC402Y3V151KT6R', 'one', 1_000, false)
      await saveAt('01PAW75F73PVC402Y3V151KT6R', 'two', 2_000, true)
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
          workspaceId: '01ECWTM29HBA5A9MXS76EM7JHR',
          createdAt: own.createdAt + 5_000,
        })
        .execute()
      const before = await idsOf('01PAW75F73PVC402Y3V151KT6R')
      expect(await store.pruneSandwichedAutoVersions('01PAW75F73PVC402Y3V151KT6R', 'doc')).toEqual({
        deletedCount: 0,
        deletedIds: [],
      })
      expect(await idsOf('01PAW75F73PVC402Y3V151KT6R')).toEqual(before)
    })

    it("leaves a neighbour's sandwiched autos under the same document id alone", async () => {
      const manual = await saveAt('01PAW75F73PVC402Y3V151KT6R', 'one', 1_000, false)
      const own = await handle.db
        .selectFrom('versions')
        .selectAll()
        .where('id', '=', manual.id)
        .executeTakeFirstOrThrow()
      const foreign = (id: string, auto: 0 | 1, dt: number) => ({
        ...own,
        id,
        auto,
        workspaceId: '01ECWTM29HBA5A9MXS76EM7JHR',
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
      await store.pruneSandwichedAutoVersions('01PAW75F73PVC402Y3V151KT6R', 'doc')
      expect(await idsOf('01ECWTM29HBA5A9MXS76EM7JHR')).toEqual([
        'foreign-1',
        'foreign-2',
        'foreign-3',
      ])
    })
  })

  describe('adopt', () => {
    it('keeps the element count the carried version was judged with', async () => {
      const kept = await store.adopt('01PAW75F73PVC402Y3V151KT6R', [
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
      await checkpoint('01PAW75F73PVC402Y3V151KT6R', 'one', 1_000)
      await checkpoint('01PAW75F73PVC402Y3V151KT6R', 'two', 2_000)
      expect(await store.isUnchangedSinceLastVersion('01PAW75F73PVC402Y3V151KT6R', 'doc')).toBe(
        true,
      )
    })

    it('reports a change when the content has gone back to an OLDER version', async () => {
      await checkpoint('01PAW75F73PVC402Y3V151KT6R', 'one', 1_000)
      await checkpoint('01PAW75F73PVC402Y3V151KT6R', 'two', 2_000)
      await edit('01PAW75F73PVC402Y3V151KT6R', 'one')
      expect(await store.isUnchangedSinceLastVersion('01PAW75F73PVC402Y3V151KT6R', 'doc')).toBe(
        false,
      )
    })

    it('ignores a newer row another workspace holds for the same document id', async () => {
      await checkpoint('01PAW75F73PVC402Y3V151KT6R', 'one', 1_000)
      const own = await handle.db
        .selectFrom('versions')
        .selectAll()
        .where('workspaceId', '=', '01PAW75F73PVC402Y3V151KT6R')
        .executeTakeFirstOrThrow()
      await handle.db
        .insertInto('versions')
        .values({
          ...own,
          id: 'foreign-row',
          workspaceId: '01ECWTM29HBA5A9MXS76EM7JHR',
          contentDigest: 'a-digest-no-document-has',
          createdAt: own.createdAt + 1_000,
        })
        .execute()
      expect(await store.isUnchangedSinceLastVersion('01PAW75F73PVC402Y3V151KT6R', 'doc')).toBe(
        true,
      )
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
      await edit('01ECWTM29HBA5A9MXS76EM7JHR', 'b')
      await at(500, () =>
        store.save('01ECWTM29HBA5A9MXS76EM7JHR', 'doc', new LoroDoc(), { auto: false }),
      )
      await edit('01PAW75F73PVC402Y3V151KT6R', 'one')
      const first = await at(1_000, () =>
        store.save('01PAW75F73PVC402Y3V151KT6R', 'doc', new LoroDoc(), { auto: false }),
      )
      await edit('01PAW75F73PVC402Y3V151KT6R', 'two')
      const second = await at(2_000, () =>
        store.save('01PAW75F73PVC402Y3V151KT6R', 'doc', new LoroDoc(), { auto: false }),
      )

      const points = (await store.workspaceVersionFrontiers('01PAW75F73PVC402Y3V151KT6R')).map(
        frontiersToBase64,
      )
      expect(points.sort()).toEqual(
        [await frontiersOf(first.id), await frontiersOf(second.id)].sort(),
      )
    })

    it('lets compaction cut only where every version descends from, whatever a row is dated', async () => {
      // Rewriting one node grows the op log the cut folds away, so the
      // compaction below has something to gain and really runs.
      for (let i = 0; i < 40; i++) await edit('01PAW75F73PVC402Y3V151KT6R', `churn-${i}`)
      const first = await at(1_000, () =>
        store.save('01PAW75F73PVC402Y3V151KT6R', 'doc', new LoroDoc(), { auto: false }),
      )
      await edit('01PAW75F73PVC402Y3V151KT6R', 'after')
      const asSaved = (await store.load('01PAW75F73PVC402Y3V151KT6R', first.id))?.toJSON()
      const { documentId } = await handle.db
        .selectFrom('versions')
        .select('documentId')
        .where('id', '=', first.id)
        .executeTakeFirstOrThrow()
      // Dated before every other row while standing at the HEAD: oldest by
      // time, newest in the history.
      const head = (await getWorkspaceDoc('01PAW75F73PVC402Y3V151KT6R')).frontiers()
      const carried = { id: 'carried-at-head', documentId, createdAt: 0, auto: false }
      await store.adopt('01PAW75F73PVC402Y3V151KT6R', [
        { ...carried, frontiers: head, elementCount: 1, contentDigest: 'x' },
      ])

      expect((await compactWorkspace('01PAW75F73PVC402Y3V151KT6R', store)).compacted).toBe(true)
      _clearWorkspaceDocCacheForTests()
      expect(asSaved).toBeDefined()
      expect((await store.load('01PAW75F73PVC402Y3V151KT6R', first.id))?.toJSON()).toEqual(asSaved)
    })

    it('is empty for a workspace with no versions', async () => {
      await expect(store.workspaceVersionFrontiers('01PAW75F73PVC402Y3V151KT6R')).resolves.toEqual(
        [],
      )
    })
  })
})
