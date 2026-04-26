import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LoroDoc } from 'loro-crdt'

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
const { saveCanvas, loadCanvas, listCanvases, listWorkspaces, compactCanvas } = await import('./canvas-store.js')
const { FileVersionStore } = await import('./version-store.js')

describe('saveCanvas / loadCanvas', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'whiteboard-test-'))
    // Create the session directory.
    const { mkdir } = await import('node:fs/promises')
    await mkdir(join(tempDir, 'session1'), { recursive: true })
  })

  afterEach(async () => {
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

    const elements = loaded.getMovableList('elements').toJSON() as { id: string; type: string; x: number }[]
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
    const { mkdir } = await import('node:fs/promises')
    const blobDir = join(tempDir, 'blobs', 'session1', 'canvas')
    await mkdir(blobDir, { recursive: true })
    await writeFile(join(blobDir, 'broken.loro'), Buffer.from('not-a-loro-snapshot'))

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
    const { mkdir } = await import('node:fs/promises')
    await mkdir(join(tempDir, 'session1'), { recursive: true })
  })

  afterEach(async () => {
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
    await expect(saveCanvas('session1', 'existing', new LoroDoc())).rejects.toThrow(/already exists/)
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
})

describe('listCanvases', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'whiteboard-test-'))
    const { mkdir } = await import('node:fs/promises')
    await mkdir(join(tempDir, 'session1'), { recursive: true })
  })

  afterEach(async () => {
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
  })

  afterEach(async () => {
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
    await expect(saveCanvas('session1', '621/header-v2/layout', new LoroDoc())).resolves.toBeUndefined()
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
    await expect(saveCanvas('session1', 'foo/.hidden', new LoroDoc())).rejects.toThrow('Invalid slug')
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
    await expect(saveCanvas('..', 'safe-slug', new LoroDoc())).rejects.toThrow('Invalid workspaceId')
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
  })

  afterEach(async () => {
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
    await expect(
      saveCanvas('session1', 'valid-top/.bad', new LoroDoc()),
    ).rejects.toThrow(/"valid-top\/\.bad"/)
  })
})

describe('listWorkspaces', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'whiteboard-test-'))
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it('lists workspaces seeded via saveCanvas', async () => {
    await saveCanvas('session-active', 'a', new LoroDoc())
    await saveCanvas('session-old', 'a', new LoroDoc())
    const { writeFile } = await import('node:fs/promises')
    await writeFile(
      join(tempDir, 'daemon.json'),
      JSON.stringify({
        pid: process.pid,
        port: 3099,
        token: 'secret',
        version: '0.1.0',
        startedAt: '2026-04-23T00:00:00.000Z',
      }),
    )

    const workspaces = await listWorkspaces()
    const ids = workspaces.map((s) => s.workspaceId)
    expect(ids).toContain('session-active')
    expect(ids).toContain('session-old')
    for (const ws of workspaces) {
      expect(ws.daemonAlive).toBe(true)
    }
  })

  it('treats stale daemon.json entries with dead PIDs as daemonAlive=false', async () => {
    await saveCanvas('session-stale', 'a', new LoroDoc())
    const { writeFile } = await import('node:fs/promises')
    await writeFile(
      join(tempDir, 'daemon.json'),
      JSON.stringify({
        pid: 999999999,
        port: 3099,
        token: 'secret',
        version: '0.1.0',
        startedAt: '2026-04-23T00:00:00.000Z',
      }),
    )

    const workspaces = await listWorkspaces()
    const stale = workspaces.find((s) => s.workspaceId === 'session-stale')
    expect(stale?.daemonAlive).toBe(false)
  })

  it('treats daemonAlive as false when daemon.json is missing', async () => {
    await saveCanvas('session-legacy', 'a', new LoroDoc())
    const workspaces = await listWorkspaces()
    const legacy = workspaces.find((s) => s.workspaceId === 'session-legacy')
    expect(legacy?.daemonAlive).toBe(false)
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
    const { mkdir } = await import('node:fs/promises')
    await mkdir(join(tempDir, 'session1'), { recursive: true })
  })

  afterEach(async () => {
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
    const { mkdir } = await import('node:fs/promises')
    const doc = new LoroDoc()
    const store = new FileVersionStore()
    await saveCanvas('session1', 'broken', doc)
    await store.save('session1', 'broken', doc, { auto: true })
    const blobPath = join(tempDir, 'blobs', 'session1', 'canvas', 'broken.loro')
    await mkdir(join(tempDir, 'blobs', 'session1', 'canvas'), { recursive: true })
    await writeFile(blobPath, Buffer.from('not-a-loro-snapshot'))

    await expect(compactCanvas('session1', 'broken', store)).rejects.toMatchObject({
      name: 'CorruptStoredDataError',
      message: expect.stringContaining('broken.loro'),
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
})
