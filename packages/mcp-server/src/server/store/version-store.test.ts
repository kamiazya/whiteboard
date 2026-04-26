import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LoroDoc, LoroMap } from 'loro-crdt'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Tests for the native Loro version store backed by the sqlite metadata DB.
// Frontiers and metadata live in the versions table; thumbnails live as PNG
// blobs under blobs/{ws}/versions/.

let tempDir: string

vi.mock('../config.js', () => ({
  get DATA_DIR() {
    return tempDir
  },
  WHITEBOARD_ROOT: '/tmp',
  REPO_ROOT: '/tmp',
  DIST_APP_DIR: '/tmp/dist/app',
}))

const { FileVersionStore } = await import('./version-store.js')

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

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'version-store-test-'))
    store = new FileVersionStore()
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it('save records elementCount and returns a VersionEntry', async () => {
    const doc = new LoroDoc()
    appendElement(doc, 'e1')
    appendElement(doc, 'e2')
    appendElement(doc, 'e3')
    const entry = await store.save('sess-1', 'canvas-a', doc, { auto: true })
    expect(entry.id).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(entry.slug).toBe('canvas-a')
    expect(entry.elementCount).toBe(3)
    expect(entry.auto).toBe(true)
    expect(entry.label).toBeUndefined()
    expect(entry.hasThumbnail).toBe(false)
    expect(entry.branchName).toBe('main')
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
    const live = new LoroDoc()
    appendElement(live, 'a')
    const entry = await store.save('sess-1', 'canvas-a', live, { auto: true, label: 'v1' })

    appendElement(live, 'b')
    appendElement(live, 'c')
    expect(countElements(live)).toBe(3)

    const past = await store.load('sess-1', entry.id, live)
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
    const entry = await store.save('sess-1', 'canvas-a', live, { auto: true })
    appendElement(live, 'x2')
    const liveCountBefore = countElements(live)

    await store.load('sess-1', entry.id, live)

    expect(countElements(live)).toBe(liveCountBefore)
    appendElement(live, 'x3')
    expect(countElements(live)).toBe(liveCountBefore + 1)
  })

  it('returns null for an unknown version id', async () => {
    const live = new LoroDoc()
    const past = await store.load('sess-1', 'nope', live)
    expect(past).toBeNull()
  })

  it('filters list by slug and returns newest first', async () => {
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
    const live = new LoroDoc()
    await expect(store.load('sess-1', '../escape', live)).rejects.toThrow(/Invalid version id/i)
    await expect(store.load('sess-1', 'a.b', live)).rejects.toThrow(/Invalid version id/i)
    await expect(store.load('sess-1', '', live)).rejects.toThrow(/Invalid version id/i)
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
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47])
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

    it('renameBranchInVersions rewrites branchName for every version on the target slug', async () => {
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

  it('earliestFrontiers returns null when no versions exist', async () => {
    await expect(store.earliestFrontiers('sess-1', 'canvas-a')).resolves.toBeNull()
  })

  it('earliestFrontiers returns the oldest stored frontiers for the slug', async () => {
    const a = new LoroDoc()
    appendElement(a, 'a1')
    await store.save('sess-1', 'canvas-a', a, { auto: true })
    appendElement(a, 'a2')
    await store.save('sess-1', 'canvas-a', a, { auto: true })

    const frontiers = await store.earliestFrontiers('sess-1', 'canvas-a')
    expect(frontiers).not.toBeNull()
    // Decoded Frontiers is a non-empty array of OpId-shaped objects.
    expect(Array.isArray(frontiers)).toBe(true)
  })
})
