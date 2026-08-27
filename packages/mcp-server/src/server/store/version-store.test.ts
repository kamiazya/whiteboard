import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LoroDoc, LoroMap } from 'loro-crdt'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeSpatialDoc } from '../../shared/test-utils/spatial-doc.js'

// Tests for the native Loro version store backed by the sqlite metadata DB.
// Frontiers and metadata live in the versions table; thumbnails live as PNG
// blobs under blobs/{ws}/versions/.

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

// Version save refuses a path with no document, so tests seed each path they
// checkpoint — the shape production always has (auto-version fires after
// saveDocument; manual save requires an existing document).
async function seedDocuments(workspaceId: string, paths: string[]): Promise<void> {
  for (const path of paths) {
    await saveDocument(workspaceId, path, new LoroDoc(), { kind: 'spatial' })
  }
}

function appendElement(doc: LoroDoc, id: string, type = 'rectangle'): void {
  const list = doc.getMovableList('elements')
  const m = list.insertContainer(list.length, new LoroMap())
  m.set('id', id)
  m.set('type', type)
  doc.commit()
}

function countElements(doc: LoroDoc): number {
  const list = doc.getMovableList('elements').toJSON() as Array<{ isDeleted?: boolean }>
  return list.filter((e) => !e.isDeleted).length
}

describe('FileVersionStore (Loro native, sqlite-backed)', () => {
  let store: InstanceType<typeof FileVersionStore>
  let handle: Awaited<ReturnType<typeof import('./db/test-helpers.js').createIsolatedDb>>

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'version-store-test-'))
    const { createIsolatedDb } = await import('./db/test-helpers.js')
    handle = await createIsolatedDb({ dataDir: tempDir })
    store = new FileVersionStore()
    await seedDocuments('sess-1', ['canvas-a', 'canvas-b', 'canvas-x', 'canvas-y', 'canvas-z'])
  })

  afterEach(async () => {
    await handle.dispose()
    await rm(tempDir, { recursive: true, force: true })
  })

  it('save records elementCount and returns a VersionEntry', async () => {
    const doc = new LoroDoc()
    appendElement(doc, 'e1')
    appendElement(doc, 'e2')
    appendElement(doc, 'e3')
    const entry = await store.save('sess-1', 'canvas-a', doc, { auto: true })
    expect(entry.id).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(entry.path).toBe('canvas-a')
    expect(entry.elementCount).toBe(3)
    expect(entry.auto).toBe(true)
    expect(entry.label).toBeUndefined()
    expect(entry.hasThumbnail).toBe(false)
    expect(entry.branchName).toBe('main')
  })

  it('save counts nodes-model nodes, not the retired legacy elements list', async () => {
    const doc = makeSpatialDoc({
      nodes: [
        { id: 'n1', type: 'text', text: 'a', x: 0, y: 0, width: 10, height: 10 },
        { id: 'n2', type: 'text', text: 'b', x: 0, y: 0, width: 10, height: 10 },
        { id: 'n3', type: 'text', text: 'c', x: 0, y: 0, width: 10, height: 10 },
      ],
      edges: [{ id: 'e1', fromNode: 'n1', toNode: 'n2' }],
    })
    const entry = await store.save('sess-1', 'canvas-a', doc, { auto: true })
    expect(entry.elementCount).toBe(3)
    const [listed] = await store.list('sess-1', 'canvas-a')
    expect(listed?.elementCount).toBe(3)
  })

  it('save falls back to counting alive legacy elements for a pre-migration doc', async () => {
    const doc = new LoroDoc()
    appendElement(doc, 'e1')
    appendElement(doc, 'e2')
    const list = doc.getMovableList('elements')
    const dead = list.insertContainer(list.length, new LoroMap())
    dead.set('id', 'e3')
    dead.set('isDeleted', true)
    doc.commit()

    const entry = await store.save('sess-1', 'canvas-a', doc, { auto: true })
    expect(entry.elementCount).toBe(2)
  })

  it('save keeps its fail-soft 0 when the spatial read throws', async () => {
    const doc = new LoroDoc()
    appendElement(doc, 'e1')
    vi.spyOn(doc, 'getMap').mockImplementation(() => {
      throw new Error('boom')
    })
    const entry = await store.save('sess-1', 'canvas-a', doc, { auto: true })
    expect(entry.elementCount).toBe(0)
  })

  it('round-trips save({ operator }) through list()', async () => {
    const doc = new LoroDoc()
    appendElement(doc, 'e1')
    const entry = await store.save('sess-1', 'canvas-a', doc, {
      auto: false,
      label: 'manual',
      operator: {
        kind: 'ai',
        peerId: 'peer-ai',
        displayName: 'Assistant',
        agentId: 'agent-1',
        workspaceId: 'session-1',
      },
    })

    expect(entry.operator).toEqual({
      kind: 'ai',
      peerId: 'peer-ai',
      displayName: 'Assistant',
      agentId: 'agent-1',
      workspaceId: 'session-1',
    })
    const listed = await store.list('sess-1', 'canvas-a')
    expect(listed[0]?.operator).toEqual(entry.operator)
  })

  it('list returns operator=undefined for entries saved without an operator', async () => {
    const doc = new LoroDoc()
    appendElement(doc, 'e1')
    await store.save('sess-1', 'canvas-a', doc, { auto: true })
    const listed = await store.list('sess-1', 'canvas-a')
    expect(listed).toHaveLength(1)
    expect(listed[0]?.operator).toBeUndefined()
  })

  it('load returns the past-state doc from save time', async () => {
    // Content must be PERSISTED for a checkpoint to capture it: frontiers
    // point into the stored workspace record's oplog, so in-memory edits
    // that never went through saveDocument are invisible to a version.
    const live = new LoroDoc()
    appendElement(live, 'a')
    await saveDocument('sess-1', 'canvas-a', live, { kind: 'spatial', overwrite: true })
    const entry = await store.save('sess-1', 'canvas-a', live, { auto: true, label: 'v1' })

    appendElement(live, 'b')
    appendElement(live, 'c')
    await saveDocument('sess-1', 'canvas-a', live, { kind: 'spatial', overwrite: true })
    expect(countElements(live)).toBe(3)

    const past = await store.load('sess-1', entry.id)
    expect(past).not.toBeNull()
    expect(countElements(past!)).toBe(1)
    const pastIds = (past!.getMovableList('elements').toJSON() as Array<{ id: string }>).map(
      (e) => e.id,
    )
    expect(pastIds).toEqual(['a'])
  })

  it('load does not mutate the live doc', async () => {
    const live = new LoroDoc()
    appendElement(live, 'x1')
    await saveDocument('sess-1', 'canvas-a', live, { kind: 'spatial', overwrite: true })
    const entry = await store.save('sess-1', 'canvas-a', live, { auto: true })
    appendElement(live, 'x2')
    const liveCountBefore = countElements(live)

    await store.load('sess-1', entry.id)

    expect(countElements(live)).toBe(liveCountBefore)
    appendElement(live, 'x3')
    expect(countElements(live)).toBe(liveCountBefore + 1)
  })

  it('returns null for an unknown version id', async () => {
    const past = await store.load('sess-1', 'nope')
    expect(past).toBeNull()
  })

  it('filters list by path and returns newest first', async () => {
    const a = new LoroDoc()
    appendElement(a, 'a1')
    await store.save('sess-1', 'canvas-a', a, { auto: true })

    const b = new LoroDoc()
    appendElement(b, 'b1')
    appendElement(b, 'b2')
    await store.save('sess-1', 'canvas-b', b, { auto: true })

    await store.save('sess-1', 'canvas-a', a, { auto: false, label: 'v2' })

    const listA = await store.list('sess-1', 'canvas-a')
    expect(listA).toHaveLength(2)
    expect(listA[0].label).toBe('v2') // Newest first.

    const listB = await store.list('sess-1', 'canvas-b')
    expect(listB).toHaveLength(1)
    expect(listB[0].elementCount).toBe(2)
  })

  it('rejects invalid ids during validation', async () => {
    await expect(store.load('sess-1', '../escape')).rejects.toThrow(/Invalid version id/i)
    await expect(store.load('sess-1', 'a.b')).rejects.toThrow(/Invalid version id/i)
    await expect(store.load('sess-1', '')).rejects.toThrow(/Invalid version id/i)
  })

  it('round-trips saveThumbnail -> loadThumbnail and updates hasThumbnail', async () => {
    const doc = new LoroDoc()
    appendElement(doc, 'e1')
    const entry = await store.save('sess-1', 'canvas-a', doc, { auto: false, label: 'v1' })

    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    await store.saveThumbnail('sess-1', entry.id, png)
    const loaded = await store.loadThumbnail('sess-1', entry.id)
    expect(loaded).not.toBeNull()
    expect(Array.from(loaded!)).toEqual(Array.from(png))

    const list = await store.list('sess-1', 'canvas-a')
    expect(list.find((v) => v.id === entry.id)!.hasThumbnail).toBe(true)
  })

  it('returns null from loadThumbnail for an unsaved id', async () => {
    const res = await store.loadThumbnail('sess-1', 'whatever')
    expect(res).toBeNull()
  })

  it('refuses saveThumbnail for an id that does not belong to the workspace, leaving no orphan PNG', async () => {
    // Older code wrote the blob first and then ran a workspace-scoped UPDATE.
    // A foreign / hostile / deleted version id matched zero rows but the PNG
    // was still on disk forever. The fix is "scope check before write" — this
    // test pins that order so a future refactor can't reintroduce the orphan.
    const doc = new LoroDoc()
    appendElement(doc, 'e1')
    const ownEntry = await store.save('sess-1', 'canvas-a', doc, { auto: true })
    // ownEntry.id only exists in sess-1; pretending it belongs to sess-2 is
    // exactly the cross-workspace case we want to reject.
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    await expect(store.saveThumbnail('sess-2', ownEntry.id, png)).rejects.toThrow()
    await expect(store.loadThumbnail('sess-2', ownEntry.id)).resolves.toBeNull()

    // Sanity check: the legitimate workspace can still save / load.
    await store.saveThumbnail('sess-1', ownEntry.id, png)
    const loaded = await store.loadThumbnail('sess-1', ownEntry.id)
    expect(loaded).not.toBeNull()
  })

  it('does not swallow non-missing read failures in loadThumbnail', async () => {
    const dir = join(tempDir, 'blobs', 'sess-1', 'versions')
    await mkdir(join(dir, 'broken-thumb.png'), { recursive: true })

    await expect(store.loadThumbnail('sess-1', 'broken-thumb')).rejects.toMatchObject({
      name: 'CorruptStoredDataError',
      message: expect.stringContaining('broken-thumb.png'),
    })
  })

  it('rejects thumbnails larger than 2MB', async () => {
    const doc = new LoroDoc()
    appendElement(doc, 'e1')
    const entry = await store.save('sess-1', 'canvas-a', doc, { auto: true })
    const huge = new Uint8Array(2 * 1024 * 1024 + 1)
    await expect(store.saveThumbnail('sess-1', entry.id, huge)).rejects.toThrow(/exceeds/i)
  })

  it('keeps auto versions capped at 50 per canvas while preserving manual versions', async () => {
    const doc = new LoroDoc()
    appendElement(doc, 'e1')
    const manualEntry = await store.save('sess-1', 'canvas-a', doc, {
      auto: false,
      label: 'keep me',
    })

    for (let i = 0; i < 52; i++) {
      appendElement(doc, `auto-${i}`)
      await store.save('sess-1', 'canvas-a', doc, { auto: true })
    }

    const list = await store.list('sess-1', 'canvas-a')
    const autos = list.filter((v) => v.auto)
    const manuals = list.filter((v) => !v.auto)
    expect(autos.length).toBeLessThanOrEqual(50)
    expect(manuals.some((v) => v.id === manualEntry.id)).toBe(true)
  })

  it('prune also removes the thumbnail blobs of evicted auto versions', async () => {
    const doc = new LoroDoc()
    appendElement(doc, 'e1')
    // Save the first auto and attach a thumbnail before any eviction can happen.
    const evictable = await store.save('sess-1', 'canvas-a', doc, { auto: true })
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    await store.saveThumbnail('sess-1', evictable.id, png)
    expect(await store.loadThumbnail('sess-1', evictable.id)).not.toBeNull()

    // Push 50 more autos so the original one falls out of the retention window.
    for (let i = 0; i < 50; i++) {
      appendElement(doc, `auto-${i}`)
      await store.save('sess-1', 'canvas-a', doc, { auto: true })
    }

    expect(await store.loadThumbnail('sess-1', evictable.id)).toBeNull()
  })

  describe('branchName', () => {
    it('persists opts.branchName into the entry and metadata', async () => {
      const doc = new LoroDoc()
      appendElement(doc, 'e1')
      const entry = await store.save('sess-1', 'canvas-a', doc, {
        auto: true,
        branchName: 'feature-x',
      })
      expect(entry.branchName).toBe('feature-x')
      const listed = await store.list('sess-1', 'canvas-a')
      expect(listed[0]?.branchName).toBe('feature-x')
    })

    it('defaults branchName to "main" when omitted', async () => {
      const doc = new LoroDoc()
      appendElement(doc, 'e1')
      const entry = await store.save('sess-1', 'canvas-a', doc, { auto: true })
      expect(entry.branchName).toBe('main')
    })

    it('renameBranchInVersions rewrites branchName for every version on the target path', async () => {
      const a = new LoroDoc()
      appendElement(a, 'a1')
      const v1 = await store.save('sess-1', 'canvas-a', a, { auto: true, branchName: 'feature' })
      appendElement(a, 'a2')
      const v2 = await store.save('sess-1', 'canvas-a', a, { auto: true, branchName: 'feature' })
      const b = new LoroDoc()
      appendElement(b, 'b1')
      const vOther = await store.save('sess-1', 'canvas-b', b, {
        auto: true,
        branchName: 'feature',
      })
      const vMain = await store.save('sess-1', 'canvas-a', a, { auto: true, branchName: 'main' })

      const renamedCount = await store.renameBranchInVersions(
        'sess-1',
        'canvas-a',
        'feature',
        'experimental',
      )
      expect(renamedCount).toBe(2)
      const list = await store.list('sess-1', 'canvas-a')
      const byId = new Map(list.map((v) => [v.id, v.branchName]))
      expect(byId.get(v1.id)).toBe('experimental')
      expect(byId.get(v2.id)).toBe('experimental')
      expect(byId.get(vMain.id)).toBe('main')
      const listB = await store.list('sess-1', 'canvas-b')
      expect(listB.find((v) => v.id === vOther.id)?.branchName).toBe('feature')
    })

    it('returns 0 when no version row matches the source branch', async () => {
      await expect(
        store.renameBranchInVersions('sess-1', 'canvas-a', 'feature', 'experimental'),
      ).resolves.toBe(0)
    })

    it('returns 0 for a no-op rename (oldName === newName)', async () => {
      const doc = new LoroDoc()
      appendElement(doc, 'e1')
      await store.save('sess-1', 'canvas-a', doc, { auto: true, branchName: 'feature' })
      await expect(
        store.renameBranchInVersions('sess-1', 'canvas-a', 'feature', 'feature'),
      ).resolves.toBe(0)
    })
  })

  // Version save must not CREATE documents: a minted row here has no kind
  // and no workspace-tree node — a corrupt state the boot fold deletes and
  // the listing contract rejects. Creating documents is saveDocument /
  // createDocument's job alone, and a checkpoint of a document that does
  // not exist checkpoints nothing.
  it('save refuses a path with no document instead of minting a phantom row', async () => {
    const doc = new LoroDoc()
    appendElement(doc, 'e1')
    await expect(store.save('sess-1', 'never-created', doc, { auto: true })).rejects.toThrow(
      /no document/i,
    )
  })

  // Versions are keyed on workspaceId directly (dual-plane collapse S3):
  // every workspace-scoped query used to reach the workspaceId through the
  // documents table, which was the version table's last read dependency on
  // the row plane.
  it('save records the workspaceId on the version row', async () => {
    const doc = new LoroDoc()
    appendElement(doc, 'e1')
    const entry = await store.save('sess-1', 'canvas-a', doc, { auto: true })

    const { getDb } = await import('./db/index.js')
    const db = await getDb(tempDir)
    const row = await db
      .selectFrom('versions')
      .select(['workspaceId'])
      .where('id', '=', entry.id)
      .executeTakeFirst()
    expect(row).toEqual({ workspaceId: 'sess-1' })
  })

  describe('pruneSandwichedAutoVersions', () => {
    // Save a version while pinning Date.now() so chronological order is
    // deterministic regardless of how fast the test runs.
    async function saveAt(
      path: string,
      kind: 'auto' | 'manual',
      tMs: number,
    ): Promise<{ id: string }> {
      const doc = new LoroDoc()
      appendElement(doc, `${kind}-${tMs}`)
      // Capture the spy handle so we can mockRestore() in finally — the
      // previous "re-spy with realNow" trick installed a new spy on top of
      // an already-spied Date.now from a sibling call, leaking the wrapper
      // into later assertions instead of restoring the original.
      const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => tMs)
      try {
        const entry = await store.save('sess-1', path, doc, {
          auto: kind === 'auto',
          label: kind === 'manual' ? `manual-${tMs}` : undefined,
        })
        return { id: entry.id }
      } finally {
        nowSpy.mockRestore()
      }
    }

    it('drops auto versions strictly between two manual versions but keeps autos before the first / after the last', async () => {
      // Pattern: M1, A1, A2, M2, A3, M3, A4
      // Expected after prune: M1, M2, M3, A4 (A1, A2 are sandwiched between
      // M1 and M2; A3 is sandwiched between M2 and M3; A4 is after the last
      // manual so it stays).
      const m1 = await saveAt('canvas-x', 'manual', 1_000)
      const a1 = await saveAt('canvas-x', 'auto', 2_000)
      const a2 = await saveAt('canvas-x', 'auto', 3_000)
      const m2 = await saveAt('canvas-x', 'manual', 4_000)
      const a3 = await saveAt('canvas-x', 'auto', 5_000)
      const m3 = await saveAt('canvas-x', 'manual', 6_000)
      const a4 = await saveAt('canvas-x', 'auto', 7_000)

      const result = await store.pruneSandwichedAutoVersions('sess-1', 'canvas-x')
      expect(result.deletedIds.sort()).toEqual([a1.id, a2.id, a3.id].sort())
      expect(result.deletedCount).toBe(3)

      const remaining = (await store.list('sess-1', 'canvas-x')).map((v) => v.id).sort()
      expect(remaining).toEqual([m1.id, m2.id, m3.id, a4.id].sort())
    })

    it('keeps every auto when fewer than two manual versions exist (nothing to sandwich)', async () => {
      const a1 = await saveAt('canvas-y', 'auto', 1_000)
      const m1 = await saveAt('canvas-y', 'manual', 2_000)
      const a2 = await saveAt('canvas-y', 'auto', 3_000)

      const result = await store.pruneSandwichedAutoVersions('sess-1', 'canvas-y')
      expect(result.deletedCount).toBe(0)
      const remaining = (await store.list('sess-1', 'canvas-y')).map((v) => v.id).sort()
      expect(remaining).toEqual([a1.id, m1.id, a2.id].sort())
    })

    it('removes the thumbnail PNG of pruned versions so disk usage actually drops', async () => {
      await saveAt('canvas-z', 'manual', 1_000)
      const a1 = await saveAt('canvas-z', 'auto', 2_000)
      await saveAt('canvas-z', 'manual', 3_000)

      // Stamp a thumbnail on the soon-to-be-pruned auto version.
      await store.saveThumbnail('sess-1', a1.id, new Uint8Array([1, 2, 3]))
      expect(await store.loadThumbnail('sess-1', a1.id)).not.toBeNull()

      const result = await store.pruneSandwichedAutoVersions('sess-1', 'canvas-z')
      expect(result.deletedIds).toEqual([a1.id])
      expect(await store.loadThumbnail('sess-1', a1.id)).toBeNull()
    })
  })
})
