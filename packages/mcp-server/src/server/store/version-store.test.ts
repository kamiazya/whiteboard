import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LoroDoc, LoroMap } from 'loro-crdt'

// Tests for the native Loro version store. It records frontiers in metadata,
// and load() returns a past-state doc through checkout.

let tempDir: string

vi.mock('../config.js', () => ({
  get DATA_DIR() {
    return tempDir
  },
  WHITEBOARD_ROOT: '/tmp',
  REPO_ROOT: '/tmp',
  DIST_APP_DIR: '/tmp/dist/app',
}))

const { FileVersionStore, pruneVersionArtifacts } = await import('./version-store.js')

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

describe('FileVersionStore (Loro native)', () => {
  let store: InstanceType<typeof FileVersionStore>

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'version-store-test-'))
    store = new FileVersionStore()
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it('save writes frontiers to metadata and returns a VersionEntry', async () => {
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
        sessionId: 'session-1',
      },
    })

    expect(entry.operator).toEqual({
      kind: 'ai',
      peerId: 'peer-ai',
      displayName: 'Assistant',
      agentId: 'agent-1',
      sessionId: 'session-1',
    })
    const listed = await store.list('sess-1', 'canvas-a')
    expect(listed[0]?.operator).toEqual(entry.operator)
  })

  it('load returns the past-state doc from save time', async () => {
    const live = new LoroDoc()
    appendElement(live, 'a')
    const entry = await store.save('sess-1', 'canvas-a', live, { auto: true, label: 'v1' })

    // Add more elements after save().
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

    // The live doc stays editable and unchanged.
    expect(countElements(live)).toBe(liveCountBefore)
    appendElement(live, 'x3') // This should still be editable.
    expect(countElements(live)).toBe(liveCountBefore + 1)
  })

  it('returns null for an unknown version id', async () => {
    const live = new LoroDoc()
    const past = await store.load('sess-1', 'nope', live)
    expect(past).toBeNull()
  })

  it('treats malformed meta JSON as corruption', async () => {
    const dir = join(tempDir, 'sess-1', 'versions')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'brokenjson.json'), '{"slug":')

    await expect(store.getFrontiersBase64('sess-1', 'brokenjson')).rejects.toMatchObject({
      name: 'CorruptStoredDataError',
      message: expect.stringContaining('brokenjson.json'),
    })
  })

  it('treats wrong-shape metadata as corruption', async () => {
    const dir = join(tempDir, 'sess-1', 'versions')
    await mkdir(dir, { recursive: true })
    await writeFile(
      join(dir, 'wrongshape.json'),
      JSON.stringify({
        slug: 'canvas-a',
        createdAt: '2026-01-01T00:00:00.000Z',
        elementCount: 1,
        auto: true,
        frontiers: 123,
      }),
    )

    await expect(store.getFrontiersBase64('sess-1', 'wrongshape')).rejects.toMatchObject({
      name: 'CorruptStoredDataError',
      message: expect.stringContaining('wrongshape.json'),
    })
  })

  it('does not collapse corrupt metadata to null on load', async () => {
    const live = new LoroDoc()
    appendElement(live, 'a')
    const dir = join(tempDir, 'sess-1', 'versions')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'brokenload.json'), '{"slug":')

    await expect(store.load('sess-1', 'brokenload', live)).rejects.toMatchObject({
      name: 'CorruptStoredDataError',
      message: expect.stringContaining('brokenload.json'),
    })
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

  it('returns corruption instead of skipping broken metadata in list()', async () => {
    const dir = join(tempDir, 'sess-1', 'versions')
    await mkdir(dir, { recursive: true })
    await writeFile(
      join(dir, 'legacy.json'),
      JSON.stringify({
        slug: 'canvas-a',
        createdAt: '2026-01-01T00:00:00.000Z',
        elementCount: 1,
        auto: true,
      }),
    )
    const doc = new LoroDoc()
    appendElement(doc, 'x')
    await store.save('sess-1', 'canvas-a', doc, { auto: true })

    await expect(store.list('sess-1', 'canvas-a')).rejects.toMatchObject({
      name: 'CorruptStoredDataError',
      message: expect.stringContaining('legacy.json'),
    })
  })

  it('legacy meta without operator is accepted and returns operator=undefined', async () => {
    const dir = join(tempDir, 'sess-1', 'versions')
    await mkdir(dir, { recursive: true })
    await writeFile(
      join(dir, 'legacy-no-operator.json'),
      JSON.stringify({
        slug: 'canvas-a',
        createdAt: '2026-01-01T00:00:00.000Z',
        elementCount: 1,
        auto: true,
        frontiers: 'AA==',
        branchName: 'main',
      }),
    )

    const listed = await store.list('sess-1', 'canvas-a')
    expect(listed).toHaveLength(1)
    expect(listed[0]?.operator).toBeUndefined()
  })

  it.each([
    [
      'invalid operator.kind',
      {
        kind: 'robot',
        peerId: 'peer-1',
      },
    ],
    [
      'empty operator.peerId',
      {
        kind: 'human',
        peerId: '',
      },
    ],
    [
      'wrong optional operator field type',
      {
        kind: 'system',
        peerId: 'peer-1',
        displayName: 42,
      },
    ],
  ])('list rejects %s as corruption', async (_label, operator) => {
    const dir = join(tempDir, 'sess-1', 'versions')
    await mkdir(dir, { recursive: true })
    await writeFile(
      join(dir, 'bad-operator.json'),
      JSON.stringify({
        slug: 'canvas-a',
        createdAt: '2026-01-01T00:00:00.000Z',
        elementCount: 1,
        auto: true,
        frontiers: 'AA==',
        branchName: 'main',
        operator,
      }),
    )

    await expect(store.list('sess-1', 'canvas-a')).rejects.toMatchObject({
      name: 'CorruptStoredDataError',
      message: expect.stringContaining('bad-operator.json'),
    })
  })

  it('rejects invalid ids during validation', async () => {
    const live = new LoroDoc()
    await expect(store.load('sess-1', '../escape', live)).rejects.toThrow(/Invalid version id/i)
    await expect(store.load('sess-1', 'a.b', live)).rejects.toThrow(/Invalid version id/i)
    await expect(store.load('sess-1', '', live)).rejects.toThrow(/Invalid version id/i)
  })

  // Thumbnail save/load support still applies to the native Loro store.
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
    const dir = join(tempDir, 'sess-1', 'versions')
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

  // branchName support.
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
      const store = new FileVersionStore()
      const a = new LoroDoc()
      appendElement(a, 'a1')
      const v1 = await store.save('sess-1', 'canvas-a', a, { auto: true, branchName: 'feature' })
      appendElement(a, 'a2')
      const v2 = await store.save('sess-1', 'canvas-a', a, { auto: true, branchName: 'feature' })
      // Other slugs and other branch names must stay untouched.
      const b = new LoroDoc()
      appendElement(b, 'b1')
      const vOther = await store.save('sess-1', 'canvas-b', b, { auto: true, branchName: 'feature' })
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

    it('returns 0 when versions/ is simply missing', async () => {
      await expect(
        store.renameBranchInVersions('sess-1', 'canvas-a', 'feature', 'experimental'),
      ).resolves.toBe(0)
    })

    it('treats versions/ read failures as corruption', async () => {
      await mkdir(join(tempDir, 'sess-1'), { recursive: true })
      await writeFile(join(tempDir, 'sess-1', 'versions'), 'not-a-directory')

      await expect(
        store.renameBranchInVersions('sess-1', 'canvas-a', 'feature', 'experimental'),
      ).rejects.toMatchObject({
        name: 'CorruptStoredDataError',
        message: expect.stringContaining(join('sess-1', 'versions')),
      })
    })

    it('treats version metadata read failures as corruption instead of skipping them', async () => {
      const dir = join(tempDir, 'sess-1', 'versions')
      await mkdir(join(dir, 'broken-read.json'), { recursive: true })

      await expect(
        store.renameBranchInVersions('sess-1', 'canvas-a', 'feature', 'experimental'),
      ).rejects.toMatchObject({
        name: 'CorruptStoredDataError',
        message: expect.stringContaining('broken-read.json'),
      })
    })

    it('treats invalid JSON metadata as corruption instead of skipping it', async () => {
      const dir = join(tempDir, 'sess-1', 'versions')
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, 'broken-json.json'), '{"slug":')

      await expect(
        store.renameBranchInVersions('sess-1', 'canvas-a', 'feature', 'experimental'),
      ).rejects.toMatchObject({
        name: 'CorruptStoredDataError',
        message: expect.stringContaining('broken-json.json'),
      })
    })

    it('treats wrong-shape metadata as corruption instead of skipping it', async () => {
      const dir = join(tempDir, 'sess-1', 'versions')
      await mkdir(dir, { recursive: true })
      await writeFile(
        join(dir, 'wrong-shape.json'),
        JSON.stringify({
          slug: 'canvas-a',
          createdAt: '2026-01-01T00:00:00.000Z',
          elementCount: 1,
          auto: true,
          frontiers: 123,
        }),
      )

      await expect(
        store.renameBranchInVersions('sess-1', 'canvas-a', 'feature', 'experimental'),
      ).rejects.toMatchObject({
        name: 'CorruptStoredDataError',
        message: expect.stringContaining('wrong-shape.json'),
      })
    })

    it('hydrates missing branchName fields to "main" when listing legacy JSON files', async () => {
      // Manually place a JSON file written by the old schema.
      const { writeFile, mkdir } = await import('node:fs/promises')
      const { join } = await import('node:path')
      const dir = join(tempDir, 'sess-1', 'versions')
      await mkdir(dir, { recursive: true })
      const legacyMeta = {
        slug: 'canvas-a',
        createdAt: '2026-04-22T00:00:00.000Z',
        elementCount: 1,
        auto: true,
        frontiers: 'AA==', // Dummy value with the right shape; checkout is not used here.
        // branchName intentionally omitted.
      }
      await writeFile(join(dir, 'legacy01.json'), JSON.stringify(legacyMeta))

      const listed = await store.list('sess-1', 'canvas-a')
      expect(listed).toHaveLength(1)
      expect(listed[0]?.branchName).toBe('main')
    })
  })

  it('does not collapse broken metadata to null in earliestFrontiers', async () => {
    const dir = join(tempDir, 'sess-1', 'versions')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'broken-oldest.json'), '{"slug":')

    await expect(store.earliestFrontiers('sess-1', 'canvas-a')).rejects.toMatchObject({
      name: 'CorruptStoredDataError',
      message: expect.stringContaining('broken-oldest.json'),
    })
  })

  it('treats missing files as a no-op in pruneVersionArtifacts', async () => {
    const dir = join(tempDir, 'sess-1', 'versions')
    await mkdir(dir, { recursive: true })

    await expect(pruneVersionArtifacts(dir, ['missing'])).resolves.toEqual([])
  })

  it('surfaces broken versions directory layouts in pruneVersionArtifacts', async () => {
    const brokenDir = join(tempDir, 'sess-1', 'versions-file')
    await mkdir(join(tempDir, 'sess-1'), { recursive: true })
    await writeFile(brokenDir, 'not-a-directory')

    const errors = await pruneVersionArtifacts(brokenDir, ['v1'])
    expect(errors).not.toHaveLength(0)
    expect(errors[0]).toMatchObject({
      name: 'CorruptStoredDataError',
      message: expect.stringContaining('versions-file'),
    })
  })

  it('does not silently treat unlink failures as success', async () => {
    const dir = join(tempDir, 'sess-1', 'versions')
    await mkdir(dir, { recursive: true })
    await mkdir(join(dir, 'stuck.json'), { recursive: true })

    const errors = await pruneVersionArtifacts(dir, ['stuck'])
    expect(errors).not.toHaveLength(0)
    expect(errors[0]).toMatchObject({
      name: 'CorruptStoredDataError',
      message: expect.stringContaining('stuck.json'),
    })
  })
})
