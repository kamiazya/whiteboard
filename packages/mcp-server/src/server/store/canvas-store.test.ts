import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LoroDoc } from 'loro-crdt'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Swap DATA_DIR to a temp directory through vi.mock.
let tempDir: string

vi.mock('../config.js', () => ({
  get DATA_DIR() {
    return tempDir
  },
  WHITEBOARD_ROOT: '/tmp/whiteboard',
  REPO_ROOT: '/tmp',
  DIST_APP_DIR: '/tmp/whiteboard/dist/app',
}))

// Use dynamic import so it runs after the mock is resolved.
const {
  saveCanvas,
  loadCanvas,
  listCanvases,
  listWorkspaces,
  compactCanvas,
  scheduleAutoCompact,
  setAutoCompactTrigger,
} = await import('./canvas-store.js')
const { FileVersionStore } = await import('./version-store.js')
const { createIsolatedDb } = await import('./db/test-helpers.js')

let handle: Awaited<ReturnType<typeof createIsolatedDb>>

async function setupIsolatedDb(): Promise<void> {
  handle = await createIsolatedDb({ dataDir: tempDir })
}

async function teardownIsolatedDb(): Promise<void> {
  await handle.dispose()
}

describe('saveCanvas / loadCanvas', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'whiteboard-test-'))
    await setupIsolatedDb()
    // Create the session directory.
    const { mkdir } = await import('node:fs/promises')
    await mkdir(join(tempDir, 'session1'), { recursive: true })
  })

  afterEach(async () => {
    await teardownIsolatedDb()
    await rm(tempDir, { recursive: true, force: true })
  })

  it('saves and restores an empty LoroDoc', async () => {
    const doc = new LoroDoc()
    await saveCanvas('session1', 'test', doc)

    const loaded = await loadCanvas('session1', 'test')
    // An empty doc should have an empty elements list.
    expect(loaded.getMovableList('elements').length).toBe(0)
  })

  it('saves and restores a LoroDoc with elements', async () => {
    const doc = new LoroDoc()
    const list = doc.getMovableList('elements')
    const map = list.insertContainer(0, new (await import('loro-crdt')).LoroMap())
    map.set('id', 'elem-001')
    map.set('type', 'rectangle')
    map.set('x', 100)
    map.set('y', 200)
    doc.commit()

    await saveCanvas('session1', 'canvas-with-elem', doc)
    const loaded = await loadCanvas('session1', 'canvas-with-elem')

    const elements = loaded.getMovableList('elements').toJSON() as {
      id: string
      type: string
      x: number
    }[]
    expect(elements).toHaveLength(1)
    expect(elements[0].id).toBe('elem-001')
    expect(elements[0].type).toBe('rectangle')
    expect(elements[0].x).toBe(100)
  })

  it('returns an empty LoroDoc for a missing canvas', async () => {
    const doc = await loadCanvas('session1', 'nonexistent')
    expect(doc.getMovableList('elements').length).toBe(0)
  })

  it('throws on broken snapshots instead of returning an empty LoroDoc', async () => {
    const { getDb } = await import('./db/index.js')
    await saveCanvas('session1', 'broken', new LoroDoc())
    const db = await getDb(tempDir)
    const row = await db
      .selectFrom('canvases')
      .select(['id'])
      .where('workspaceId', '=', 'session1')
      .where('slug', '=', 'broken')
      .executeTakeFirstOrThrow()
    const blobPath = join(tempDir, 'blobs', 'session1', 'canvas', `${row.id}.loro`)
    await writeFile(blobPath, Buffer.from('not-a-loro-snapshot'))

    await expect(loadCanvas('session1', 'broken')).rejects.toThrow()
  })

  it('saves and loads separate slugs independently', async () => {
    const doc1 = new LoroDoc()
    doc1.getMovableList('elements')
    doc1.commit()

    const doc2 = new LoroDoc()
    const list2 = doc2.getMovableList('elements')
    const { LoroMap: LM } = await import('loro-crdt')
    const m = list2.insertContainer(0, new LM())
    m.set('id', 'elem-in-canvas2')
    doc2.commit()

    await saveCanvas('session1', 'canvas-a', doc1)
    await saveCanvas('session1', 'canvas-b', doc2)

    const loadedA = await loadCanvas('session1', 'canvas-a')
    const loadedB = await loadCanvas('session1', 'canvas-b')

    expect(loadedA.getMovableList('elements').length).toBe(0)
    expect(loadedB.getMovableList('elements').length).toBe(1)
    const bElems = loadedB.getMovableList('elements').toJSON() as { id: string }[]
    expect(bElems[0].id).toBe('elem-in-canvas2')
  })
})

describe('saveCanvas - overwrite handling', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'whiteboard-test-'))
    await setupIsolatedDb()
    const { mkdir } = await import('node:fs/promises')
    await mkdir(join(tempDir, 'session1'), { recursive: true })
  })

  afterEach(async () => {
    await teardownIsolatedDb()
    await rm(tempDir, { recursive: true, force: true })
  })

  it('throws ConflictError when overwrite: false targets an existing file', async () => {
    await saveCanvas('session1', 'existing', new LoroDoc())
    await expect(
      saveCanvas('session1', 'existing', new LoroDoc(), { overwrite: false }),
    ).rejects.toThrow(/already exists/)
  })

  it('defaults to the same behavior as overwrite: false', async () => {
    await saveCanvas('session1', 'existing', new LoroDoc())
    await expect(saveCanvas('session1', 'existing', new LoroDoc())).rejects.toThrow(
      /already exists/,
    )
  })

  it('overwrites an existing file when overwrite: true', async () => {
    const docA = new LoroDoc()
    docA.getMovableList('elements')
    docA.commit()
    await saveCanvas('session1', 'existing', docA)

    const docB = new LoroDoc()
    const list = docB.getMovableList('elements')
    const { LoroMap: LM } = await import('loro-crdt')
    const m = list.insertContainer(0, new LM())
    m.set('id', 'overwritten')
    docB.commit()

    await expect(
      saveCanvas('session1', 'existing', docB, { overwrite: true }),
    ).resolves.toBeUndefined()

    const loaded = await loadCanvas('session1', 'existing')
    const elements = loaded.getMovableList('elements').toJSON() as { id: string }[]
    expect(elements).toHaveLength(1)
    expect(elements[0].id).toBe('overwritten')
  })

  it('succeeds with overwrite: false when the file does not exist yet', async () => {
    await expect(
      saveCanvas('session1', 'fresh', new LoroDoc(), { overwrite: false }),
    ).resolves.toBeUndefined()
  })

  it('sets name="ConflictError" for caller-side discrimination', async () => {
    await saveCanvas('session1', 'existing', new LoroDoc())
    await expect(
      saveCanvas('session1', 'existing', new LoroDoc(), { overwrite: false }),
    ).rejects.toMatchObject({ name: 'ConflictError' })
  })

  it('does not leave an orphan canvases row behind when the snapshot+commit step fails', async () => {
    // Older cuts of saveCanvas committed the canvases row before writing the
    // .loro file, so any failure between that DB write and the blob commit
    // stranded the row and made every future saveCanvas hit ConflictError
    // forever. The exact failure point is incidental — what matters is that
    // a partial save leaves no DB row behind. Spying on LoroDoc#export gives
    // us a deterministic way to fail in the snapshot stage that works the
    // same on root and non-root environments (chmod-based blocks would no-op
    // for root in containers / sudo).
    const exportSpy = vi.spyOn(LoroDoc.prototype, 'export').mockImplementationOnce(() => {
      throw new Error('snapshot serialization failed')
    })

    await expect(saveCanvas('session1', 'orphan-prone', new LoroDoc())).rejects.toThrow(
      /snapshot serialization failed/,
    )

    exportSpy.mockRestore()

    await expect(saveCanvas('session1', 'orphan-prone', new LoroDoc())).resolves.toBeUndefined()
  })
})

describe('listCanvases', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'whiteboard-test-'))
    await setupIsolatedDb()
    const { mkdir } = await import('node:fs/promises')
    await mkdir(join(tempDir, 'session1'), { recursive: true })
  })

  afterEach(async () => {
    await teardownIsolatedDb()
    await rm(tempDir, { recursive: true, force: true })
  })

  it('returns only .loro files as slugs without extensions', async () => {
    await saveCanvas('session1', 'canvas-a', new LoroDoc())
    await saveCanvas('session1', 'canvas-b', new LoroDoc())

    // Create a .port file and confirm it is excluded.
    const { writeFile } = await import('node:fs/promises')
    await writeFile(join(tempDir, 'session1', '.port'), '3099')

    const list = await listCanvases('session1')
    const slugs = list.map((c) => c.slug)

    expect(slugs).toContain('canvas-a')
    expect(slugs).toContain('canvas-b')
    expect(slugs).not.toContain('.port')
    expect(slugs).not.toContain('exports')
  })

  it('returns an empty array for an empty session', async () => {
    const list = await listCanvases('session1')
    expect(list).toHaveLength(0)
  })

  it('returns an empty array only when the session directory is missing', async () => {
    const list = await listCanvases('missing-session')
    expect(list).toEqual([])
  })

  it('includes updatedAt on each entry', async () => {
    await saveCanvas('session1', 'canvas-a', new LoroDoc())
    const list = await listCanvases('session1')
    expect(list[0].updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('recursively lists nested slugs as session-relative paths', async () => {
    await saveCanvas('session1', 'top-level', new LoroDoc())
    await saveCanvas('session1', '621/header', new LoroDoc())
    await saveCanvas('session1', '621/footer', new LoroDoc())
    await saveCanvas('session1', '622/a/b', new LoroDoc())

    const list = await listCanvases('session1')
    const slugs = list.map((c) => c.slug).sort()
    expect(slugs).toEqual(['621/footer', '621/header', '622/a/b', 'top-level'])
  })

  it('excludes exports/, files/, and versions/ from listing', async () => {
    const { mkdir, writeFile } = await import('node:fs/promises')
    await saveCanvas('session1', 'real-canvas', new LoroDoc())
    // Files that only look like .loro files inside exports/, files/, or versions/
    // must still be excluded. versions/ also contains .loro files for the version store.
    await mkdir(join(tempDir, 'session1', 'exports'), { recursive: true })
    await writeFile(join(tempDir, 'session1', 'exports', 'fake.loro'), '')
    await mkdir(join(tempDir, 'session1', 'files'), { recursive: true })
    await writeFile(join(tempDir, 'session1', 'files', 'another.loro'), '')
    await mkdir(join(tempDir, 'session1', 'versions'), { recursive: true })
    await writeFile(join(tempDir, 'session1', 'versions', 'snap-001.loro'), '')
    await writeFile(join(tempDir, 'session1', 'versions', 'snap-002.loro'), '')

    const list = await listCanvases('session1')
    expect(list.map((c) => c.slug)).toEqual(['real-canvas'])
  })

  // listCanvases no longer walks the filesystem; the previous corruption
  // tests against directory traversal failures and broken non-directory
  // paths no longer apply now that the listing is a SELECT against the
  // canvases table.
})

describe('saveCanvas / loadCanvas - slug validation', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'whiteboard-test-'))
    await setupIsolatedDb()
  })

  afterEach(async () => {
    await teardownIsolatedDb()
    await rm(tempDir, { recursive: true, force: true })
  })

  it('accepts valid kebab-case slugs', async () => {
    // Verify that saveCanvas does not throw.
    await expect(saveCanvas('session1', 'my-canvas', new LoroDoc())).resolves.toBeUndefined()
    await expect(saveCanvas('session1', '123-design', new LoroDoc())).resolves.toBeUndefined()
    await expect(saveCanvas('session1', 'abc', new LoroDoc())).resolves.toBeUndefined()
  })

  it('accepts slash-separated nested slugs when each segment is kebab-case', async () => {
    await expect(saveCanvas('session1', '621/header', new LoroDoc())).resolves.toBeUndefined()
    await expect(
      saveCanvas('session1', '621/header-v2/layout', new LoroDoc()),
    ).resolves.toBeUndefined()
  })

  it('rejects leading, trailing, and consecutive slashes', async () => {
    await expect(saveCanvas('session1', '/foo', new LoroDoc())).rejects.toThrow('Invalid slug')
    await expect(saveCanvas('session1', 'foo/', new LoroDoc())).rejects.toThrow('Invalid slug')
    await expect(saveCanvas('session1', 'a//b', new LoroDoc())).rejects.toThrow('Invalid slug')
  })

  it('rejects slugs that contain ".."', async () => {
    await expect(saveCanvas('session1', '../escape', new LoroDoc())).rejects.toThrow('Invalid slug')
    await expect(loadCanvas('session1', '../../etc/passwd')).rejects.toThrow('Invalid slug')
    // SAFE_SLUG_SEGMENT also rejects dots inside a segment such as `foo.bar/baz`.
    await expect(saveCanvas('session1', 'foo/.hidden', new LoroDoc())).rejects.toThrow(
      'Invalid slug',
    )
  })

  it('rejects slugs that contain dots', async () => {
    await expect(saveCanvas('session1', 'foo.bar', new LoroDoc())).rejects.toThrow('Invalid slug')
    await expect(saveCanvas('session1', '.hidden', new LoroDoc())).rejects.toThrow('Invalid slug')
  })

  it('rejects slugs that contain spaces', async () => {
    await expect(saveCanvas('session1', 'my canvas', new LoroDoc())).rejects.toThrow('Invalid slug')
  })

  it('rejects empty slugs', async () => {
    await expect(saveCanvas('session1', '', new LoroDoc())).rejects.toThrow('Invalid slug')
  })

  it('rejects slugs that end with a hyphen', async () => {
    await expect(saveCanvas('session1', 'canvas-', new LoroDoc())).rejects.toThrow('Invalid slug')
  })

  it('rejects path-traversal workspaceIds', async () => {
    await expect(saveCanvas('..', 'safe-slug', new LoroDoc())).rejects.toThrow(
      'Invalid workspaceId',
    )
    await expect(loadCanvas('../escape', 'safe-slug')).rejects.toThrow('Invalid workspaceId')
  })

  it('rejects workspaceIds that contain slashes', async () => {
    await expect(saveCanvas('nested/session', 'safe-slug', new LoroDoc())).rejects.toThrow(
      'Invalid workspaceId',
    )
    await expect(listCanvases('nested/session')).rejects.toThrow('Invalid workspaceId')
  })
})

// Slug validation error messages should identify the exact segment and reason.
describe('slug validation - self-describing error messages', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'whiteboard-test-'))
    await setupIsolatedDb()
  })

  afterEach(async () => {
    await teardownIsolatedDb()
    await rm(tempDir, { recursive: true, force: true })
  })

  it('identifies the offending segment and reason for dots', async () => {
    // The failing segment is ".hidden" and the reason is "contains '.'".
    await expect(saveCanvas('session1', 'foo/.hidden', new LoroDoc())).rejects.toThrow(
      /segment "\.hidden".*contains '\.'/,
    )
  })

  it('reports whitespace as the reason for segments with spaces', async () => {
    await expect(saveCanvas('session1', 'my canvas', new LoroDoc())).rejects.toThrow(
      /segment "my canvas".*whitespace/,
    )
  })

  it('describes a leading slash as an empty segment with slash guidance', async () => {
    await expect(saveCanvas('session1', '/foo', new LoroDoc())).rejects.toThrow(
      /empty segment.*leading\/trailing\/consecutive.*\//,
    )
  })

  it('uses the same empty-segment message for consecutive slashes', async () => {
    await expect(saveCanvas('session1', 'a//b', new LoroDoc())).rejects.toThrow(/empty segment/)
  })

  it('reports "slug is empty" for an empty slug', async () => {
    await expect(saveCanvas('session1', '', new LoroDoc())).rejects.toThrow(/slug is empty/)
  })

  it('reports "leading hyphen" for segments that start with a hyphen', async () => {
    await expect(saveCanvas('session1', '-canvas', new LoroDoc())).rejects.toThrow(
      /segment "-canvas".*leading hyphen/,
    )
  })

  it('reports "trailing hyphen" for segments that end with a hyphen', async () => {
    await expect(saveCanvas('session1', 'canvas-', new LoroDoc())).rejects.toThrow(
      /segment "canvas-".*trailing hyphen/,
    )
  })

  it('applies the generic dot rule to ".." segments', async () => {
    // ".." is caught by the normal dot rule, so no special-case message is needed.
    await expect(saveCanvas('session1', '../escape', new LoroDoc())).rejects.toThrow(
      /segment "\.\.".*contains '\.'/,
    )
  })

  it('reports "invalid character" for non-ASCII characters', async () => {
    // Normal spaces map to the whitespace case, but non-ASCII characters need a separate message.
    await expect(saveCanvas('session1', 'café', new LoroDoc())).rejects.toThrow(
      /segment "café".*invalid character/,
    )
  })

  it('includes the full slug in the error message for context', async () => {
    await expect(saveCanvas('session1', 'valid-top/.bad', new LoroDoc())).rejects.toThrow(
      /"valid-top\/\.bad"/,
    )
  })
})

describe('listWorkspaces', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'whiteboard-test-'))
    await setupIsolatedDb()
  })

  afterEach(async () => {
    await teardownIsolatedDb()
    await rm(tempDir, { recursive: true, force: true })
  })

  it('lists workspaces seeded via saveCanvas', async () => {
    await saveCanvas('session-active', 'a', new LoroDoc())
    await saveCanvas('session-old', 'a', new LoroDoc())

    const workspaces = await listWorkspaces()
    const ids = workspaces.map((s) => s.workspaceId)
    expect(ids).toContain('session-active')
    expect(ids).toContain('session-old')
  })

  it('returns an empty array when no workspaces have been saved yet', async () => {
    const workspaces = await listWorkspaces()
    expect(workspaces).toHaveLength(0)
  })

  // listWorkspaces is now backed by the workspaces table, so the previous
  // "non-directory DATA_DIR" corruption check no longer applies.
})

describe('compactCanvas', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'whiteboard-compact-test-'))
    await setupIsolatedDb()
    const { mkdir } = await import('node:fs/promises')
    await mkdir(join(tempDir, 'session1'), { recursive: true })
  })

  afterEach(async () => {
    await teardownIsolatedDb()
    await rm(tempDir, { recursive: true, force: true })
  })

  it('does not compact when no version exists', async () => {
    const doc = new LoroDoc()
    doc.getMovableList('elements').insert(0, 'x')
    doc.commit()
    await saveCanvas('session1', 'test', doc)

    const store = new FileVersionStore()
    const result = await compactCanvas('session1', 'test', store)
    expect(result.compacted).toBe(false)
    expect(result.reason).toBe('no-versions')
  })

  it('returns no-file when the .loro file is missing', async () => {
    const store = new FileVersionStore()
    const result = await compactCanvas('session1', 'missing', store)
    expect(result).toEqual({ compacted: false, beforeBytes: 0, afterBytes: 0, reason: 'no-file' })
  })

  // canvas blobs no longer share their parent directory with the session
  // dir, so the previous "non-directory parent" stat failure no longer
  // applies. Coverage of the corrupt-snapshot branch lives below.

  it('treats invalid snapshots as corruption instead of falling back to empty state', async () => {
    const { getDb } = await import('./db/index.js')
    const doc = new LoroDoc()
    const store = new FileVersionStore()
    await saveCanvas('session1', 'broken', doc)
    await store.save('session1', 'broken', doc, { auto: true })
    const db = await getDb(tempDir)
    const row = await db
      .selectFrom('canvases')
      .select(['id'])
      .where('workspaceId', '=', 'session1')
      .where('slug', '=', 'broken')
      .executeTakeFirstOrThrow()
    const blobPath = join(tempDir, 'blobs', 'session1', 'canvas', `${row.id}.loro`)
    await writeFile(blobPath, Buffer.from('not-a-loro-snapshot'))

    await expect(compactCanvas('session1', 'broken', store)).rejects.toMatchObject({
      name: 'CorruptStoredDataError',
      message: expect.stringContaining(`${row.id}.loro`),
    })
  })

  it('compacts at a version cut point while keeping restore working', async () => {
    const { LoroMap } = await import('loro-crdt')
    const doc = new LoroDoc()
    const list = doc.getMovableList('elements')
    // Build a larger op log by repeatedly adding and updating elements.
    for (let i = 0; i < 30; i++) {
      const m = list.insertContainer(list.length, new LoroMap())
      m.set('id', `elem-${i}`)
      m.set('x', i)
    }
    doc.commit()
    await saveCanvas('session1', 'test', doc)

    const store = new FileVersionStore()
    const v = await store.save('session1', 'test', doc, { auto: true })

    // Add more operations after the saved version.
    for (let i = 0; i < 30; i++) {
      const m = list.insertContainer(list.length, new LoroMap())
      m.set('id', `extra-${i}`)
    }
    doc.commit()
    await saveCanvas('session1', 'test', doc, { overwrite: true })

    const result = await compactCanvas('session1', 'test', store)
    expect(result.compacted).toBe(true)
    expect(result.afterBytes).toBeLessThan(result.beforeBytes)

    // The live state should still have all 60 elements after compaction.
    const live = await loadCanvas('session1', 'test')
    expect(live.getMovableList('elements').length).toBe(60)

    // Restoring the oldest version should still work at the cut point.
    const past = await store.load('session1', v.id, live)
    expect(past).not.toBeNull()
    expect(past!.getMovableList('elements').length).toBe(30)
  })

  it('writes lastCompactedAt only on successful compaction', async () => {
    const { LoroMap } = await import('loro-crdt')
    const { getDb } = await import('./db/index.js')

    async function readLastCompactedAt(slug: string): Promise<number | null> {
      const db = await getDb(tempDir)
      const row = await db
        .selectFrom('canvases')
        .select(['lastCompactedAt'])
        .where('workspaceId', '=', 'session1')
        .where('slug', '=', slug)
        .executeTakeFirst()
      return row?.lastCompactedAt ?? null
    }

    // Case 1: no version → reason='no-versions' → lastCompactedAt stays null.
    const empty = new LoroDoc()
    empty.getMovableList('elements').insert(0, 'x')
    empty.commit()
    await saveCanvas('session1', 'untouched', empty)
    const noopStore = new FileVersionStore()
    const noop = await compactCanvas('session1', 'untouched', noopStore)
    expect(noop.reason).toBe('no-versions')
    expect(await readLastCompactedAt('untouched')).toBeNull()

    // Case 2: version cut available → reason='ok' → lastCompactedAt is set.
    const doc = new LoroDoc()
    const list = doc.getMovableList('elements')
    for (let i = 0; i < 30; i++) {
      const m = list.insertContainer(list.length, new LoroMap())
      m.set('id', `elem-${i}`)
    }
    doc.commit()
    await saveCanvas('session1', 'big', doc)
    const store = new FileVersionStore()
    await store.save('session1', 'big', doc, { auto: true })
    for (let i = 0; i < 30; i++) {
      const m = list.insertContainer(list.length, new LoroMap())
      m.set('id', `extra-${i}`)
    }
    doc.commit()
    await saveCanvas('session1', 'big', doc, { overwrite: true })

    const before = Date.now()
    const result = await compactCanvas('session1', 'big', store)
    expect(result.compacted).toBe(true)
    const after = Date.now()
    const stamp = await readLastCompactedAt('big')
    expect(stamp).not.toBeNull()
    expect(stamp!).toBeGreaterThanOrEqual(before)
    expect(stamp!).toBeLessThanOrEqual(after)
  })
})

describe('auto-compact', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'whiteboard-auto-compact-test-'))
    await setupIsolatedDb()
    const { mkdir } = await import('node:fs/promises')
    await mkdir(join(tempDir, 'session1'), { recursive: true })
  })

  afterEach(async () => {
    setAutoCompactTrigger(null)
    await teardownIsolatedDb()
    await rm(tempDir, { recursive: true, force: true })
  })

  it('saveCanvas invokes the registered auto-compact trigger', async () => {
    const trigger = vi.fn<(workspaceId: string, slug: string) => void>()
    setAutoCompactTrigger(trigger)
    await saveCanvas('session1', 'foo', new LoroDoc())
    expect(trigger).toHaveBeenCalledTimes(1)
    expect(trigger).toHaveBeenCalledWith('session1', 'foo')
  })

  it('scheduleAutoCompact debounces rapid triggers into a single compaction', async () => {
    const { LoroMap } = await import('loro-crdt')
    const { getDb } = await import('./db/index.js')

    async function readLastCompactedAt(): Promise<number | null> {
      const db = await getDb(tempDir)
      const row = await db
        .selectFrom('canvases')
        .select(['lastCompactedAt'])
        .where('workspaceId', '=', 'session1')
        .where('slug', '=', 'big')
        .executeTakeFirst()
      return row?.lastCompactedAt ?? null
    }

    // Build a canvas with a version cut + extra ops so compactCanvas
    // actually has work to do (otherwise the debounced firing would
    // just return reason: 'no-versions' and lastCompactedAt stays null).
    const doc = new LoroDoc()
    const list = doc.getMovableList('elements')
    for (let i = 0; i < 30; i++) {
      const m = list.insertContainer(list.length, new LoroMap())
      m.set('id', `e-${i}`)
    }
    doc.commit()
    await saveCanvas('session1', 'big', doc)
    const store = new FileVersionStore()
    await store.save('session1', 'big', doc, { auto: true })
    for (let i = 0; i < 30; i++) {
      const m = list.insertContainer(list.length, new LoroMap())
      m.set('id', `x-${i}`)
    }
    doc.commit()
    await saveCanvas('session1', 'big', doc, { overwrite: true })

    expect(await readLastCompactedAt()).toBeNull()

    // Three rapid triggers within the debounce window must collapse into
    // a single compactCanvas run. Use a tiny debounce so the test stays fast.
    scheduleAutoCompact('session1', 'big', store, { debounceMs: 50 })
    scheduleAutoCompact('session1', 'big', store, { debounceMs: 50 })
    scheduleAutoCompact('session1', 'big', store, { debounceMs: 50 })

    // Nothing has fired yet.
    expect(await readLastCompactedAt()).toBeNull()

    // Wait past the debounce + the async compactCanvas write.
    await new Promise((r) => setTimeout(r, 250))
    const stamp = await readLastCompactedAt()
    expect(stamp).not.toBeNull()
    const settled = stamp!

    // Further idle time without a new trigger must NOT re-compact.
    await new Promise((r) => setTimeout(r, 150))
    expect(await readLastCompactedAt()).toBe(settled)
  })

  it('evicts the doc-cache after a successful auto-compact so the next save does not clobber the compacted file', async () => {
    // The trap: scheduleAutoCompact rewrites the on-disk blob with a
    // shallow snapshot, but a still-cached full LoroDoc would re-export
    // the entire history on the next save and silently undo the
    // optimisation. Confirm the cache is dropped so getDoc reloads from
    // the compacted file.
    const { LoroMap } = await import('loro-crdt')
    const { getDoc, peekDoc, clearCache } = await import('./doc-cache.js')

    clearCache()

    const doc = new LoroDoc()
    const list = doc.getMovableList('elements')
    for (let i = 0; i < 30; i++) {
      const m = list.insertContainer(list.length, new LoroMap())
      m.set('id', `e-${i}`)
    }
    doc.commit()
    await saveCanvas('session1', 'cached', doc)
    const store = new FileVersionStore()
    await store.save('session1', 'cached', doc, { auto: true })
    for (let i = 0; i < 30; i++) {
      const m = list.insertContainer(list.length, new LoroMap())
      m.set('id', `x-${i}`)
    }
    doc.commit()
    await saveCanvas('session1', 'cached', doc, { overwrite: true })

    // Pull through getDoc so the cache holds a live LoroDoc — this is what
    // happens on every WebSocket-backed canvas in production.
    await getDoc('session1', 'cached')
    expect(peekDoc('session1', 'cached')).toBeDefined()

    scheduleAutoCompact('session1', 'cached', store, { debounceMs: 50 })
    await new Promise((r) => setTimeout(r, 250))

    // The whole point of this test: after the scheduled compaction lands,
    // the cache must be empty for that key so the next save reloads the
    // compacted file as its base.
    expect(peekDoc('session1', 'cached')).toBeUndefined()
  })
})
