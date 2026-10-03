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

  describe('earliestWorkspaceFrontiers', () => {
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

    it('is the OLDEST version in the workspace: the point compaction may cut to', async () => {
      await edit('ws-a', 'one')
      const first = await at(1_000, () => store.save('ws-a', 'doc', new LoroDoc(), { auto: false }))
      await edit('ws-a', 'two')
      await at(2_000, () => store.save('ws-a', 'doc', new LoroDoc(), { auto: false }))

      const earliest = await store.earliestWorkspaceFrontiers('ws-a')
      expect(earliest).not.toBeNull()
      if (earliest === null) return
      expect(frontiersToBase64(earliest)).toBe(await frontiersOf(first.id))
    })

    it("reads only this workspace, however old another workspace's versions are", async () => {
      await edit('ws-b', 'b')
      await at(500, () => store.save('ws-b', 'doc', new LoroDoc(), { auto: false }))
      await edit('ws-a', 'a')
      const own = await at(1_000, () => store.save('ws-a', 'doc', new LoroDoc(), { auto: false }))

      const earliest = await store.earliestWorkspaceFrontiers('ws-a')
      expect(earliest).not.toBeNull()
      if (earliest === null) return
      expect(frontiersToBase64(earliest)).toBe(await frontiersOf(own.id))
    })

    it('is null for a workspace with no versions', async () => {
      await expect(store.earliestWorkspaceFrontiers('ws-a')).resolves.toBeNull()
    })
  })
})
