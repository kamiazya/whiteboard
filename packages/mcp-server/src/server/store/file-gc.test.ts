import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LoroDoc, LoroMap } from 'loro-crdt'

let tempDir: string

vi.mock('../config.js', () => ({
  get DATA_DIR() {
    return tempDir
  },
  WHITEBOARD_ROOT: '/tmp/whiteboard',
  REPO_ROOT: '/tmp',
  DIST_APP_DIR: '/tmp/whiteboard/dist/app',
}))

const { saveCanvas, loadCanvas } = await import('./canvas-store.js')
const { purgeDanglingFiles, IncompleteFileGcScanError } = await import('./file-gc.js')
const { captureLogsForTests } = await import('../log.js')
const { FileVersionStore } = await import('./version-store.js')
const { createIsolatedDb } = await import('./db/test-helpers.js')

let handle: Awaited<ReturnType<typeof createIsolatedDb>>

async function seedFile(workspaceId: string, fileId: string, ext: string, bytes: number): Promise<void> {
  const dir = join(tempDir, workspaceId, 'files')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, `${fileId}${ext}`), Buffer.alloc(bytes, 0xab))
}

function makeDocWithImage(fileId: string): LoroDoc {
  const doc = new LoroDoc()
  const list = doc.getMovableList('elements')
  const map = list.insertContainer(0, new LoroMap())
  map.set('id', `el-${fileId}`)
  map.set('type', 'image')
  map.set('fileId', fileId)
  map.set('isDeleted', false)
  doc.commit()
  return doc
}

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'whiteboard-file-gc-test-'))
  handle = await createIsolatedDb({ dataDir: tempDir })
})

afterEach(async () => {
  await handle.dispose()
  await rm(tempDir, { recursive: true, force: true })
})

describe('purgeDanglingFiles', () => {
  it('keeps files referenced by live canvas elements and deletes the rest', async () => {
    // Two canvases reference distinct fileIds; an additional dangling file
    // and a tombstoned-element fileId both qualify for deletion.
    await saveCanvas('ws_a', 'used-a', makeDocWithImage('used-a'))
    await saveCanvas('ws_a', 'used-b', makeDocWithImage('used-b'))

    await seedFile('ws_a', 'used-a', '.png', 100)
    await seedFile('ws_a', 'used-b', '.png', 200)
    await seedFile('ws_a', 'orphan-1', '.png', 1000)
    await seedFile('ws_a', 'orphan-2', '.jpg', 500)

    const result = await purgeDanglingFiles('ws_a')

    expect(result.purgedCount).toBe(2)
    expect(result.purgedBytes).toBe(1500)

    const remaining = (await readdir(join(tempDir, 'ws_a', 'files'))).sort()
    expect(remaining).toEqual(['used-a.png', 'used-b.png'])
  })

  it('treats elements flagged isDeleted=true as not referencing their fileId', async () => {
    const doc = new LoroDoc()
    const list = doc.getMovableList('elements')
    const map = list.insertContainer(0, new LoroMap())
    map.set('id', 'tombstone')
    map.set('type', 'image')
    map.set('fileId', 'soft-deleted')
    map.set('isDeleted', true)
    doc.commit()
    await saveCanvas('ws_b', 'tombstoned', doc)

    await seedFile('ws_b', 'soft-deleted', '.png', 800)

    const result = await purgeDanglingFiles('ws_b')
    expect(result.purgedCount).toBe(1)
    expect(result.purgedBytes).toBe(800)
  })

  it('returns zero counts for a workspace with no files dir yet', async () => {
    const result = await purgeDanglingFiles('ws_empty')
    expect(result).toEqual({ purgedCount: 0, purgedBytes: 0 })
  })

  it('keeps files referenced by a saved version when versionStore is supplied', async () => {
    // Step 1: live state references "version-only" via an image element.
    await saveCanvas('ws_v', 'evolving', makeDocWithImage('version-only'))
    const store = new FileVersionStore()
    await store.save('ws_v', 'evolving', await loadCanvas('ws_v', 'evolving'), { auto: false })

    // Step 2: live state changes — remove the original element and add a
    // brand-new one. After this commit the live doc has only "live-now",
    // while the saved version still points at "version-only".
    const live = await loadCanvas('ws_v', 'evolving')
    const list = live.getMovableList('elements')
    if (list.length > 0) list.delete(0, list.length)
    const newMap = list.insertContainer(0, new LoroMap())
    newMap.set('id', 'el-live-now')
    newMap.set('type', 'image')
    newMap.set('fileId', 'live-now')
    newMap.set('isDeleted', false)
    live.commit()
    await saveCanvas('ws_v', 'evolving', live, { overwrite: true })

    await seedFile('ws_v', 'version-only', '.png', 700)
    await seedFile('ws_v', 'live-now', '.png', 300)
    await seedFile('ws_v', 'truly-dangling', '.png', 100)

    const result = await purgeDanglingFiles('ws_v', { versionStore: store })
    // Only "truly-dangling" gets dropped — the version-only reference is
    // protected by walking past versions.
    expect(result.purgedCount).toBe(1)
    expect(result.purgedBytes).toBe(100)

    const remaining = (await readdir(join(tempDir, 'ws_v', 'files'))).sort()
    expect(remaining).toEqual(['live-now.png', 'version-only.png'])
  })

  it('refuses to purge when a saved version cannot be inspected', async () => {
    // The dangerous case: list() reports a version exists but load()
    // throws, so we cannot enumerate the fileIds it referenced. The
    // older code logged + skipped, which was equivalent to "those files
    // are dangling, delete them" — permanent data loss. Now the GC
    // pass must fail closed and leave every file on disk untouched.
    // Install a structured-log capture so the warning surface is
    // asserted alongside the fail-closed contract — silent skipping is
    // the very behaviour this test exists to prevent.
    const cap = captureLogsForTests('debug')

    await saveCanvas('ws_brk', 'broken', makeDocWithImage('only-by-broken-version'))
    await seedFile('ws_brk', 'only-by-broken-version', '.png', 222)
    await seedFile('ws_brk', 'really-dangling', '.png', 33)

    const fakeStore = {
      list: async () => [
        {
          id: 'v-broken',
          slug: 'broken',
          createdAt: '2026-04-25T00:00:00.000Z',
          elementCount: 1,
          auto: false,
          hasThumbnail: false,
          branchName: 'main',
        },
      ],
      load: async () => {
        throw new Error('frontier rows missing')
      },
      // The remaining VersionStore methods are unreachable from this code path.
      save: async () => {
        throw new Error('not used')
      },
      saveThumbnail: async () => {
        throw new Error('not used')
      },
      loadThumbnail: async () => null,
      earliestFrontiers: async () => null,
      getFrontiersBase64: async () => null,
    }

    await expect(
      // biome-ignore lint/suspicious/noExplicitAny: minimal VersionStore stub for the failure path
      purgeDanglingFiles('ws_brk', { versionStore: fakeStore as any }),
    ).rejects.toBeInstanceOf(IncompleteFileGcScanError)

    // Crucially: nothing was deleted, even though only-by-broken-version
    // would have been classified as dangling under the old behaviour.
    const remaining = (await readdir(join(tempDir, 'ws_brk', 'files'))).sort()
    expect(remaining).toEqual(['only-by-broken-version.png', 'really-dangling.png'])

    try {
      const fileGcWarnings = cap.records.filter(
        (r) => r.scope === 'file-gc' && r.level === 'warning' && r.msg === 'skipped version',
      )
      expect(fileGcWarnings).toHaveLength(1)
      expect(fileGcWarnings[0].data).toMatchObject({
        workspaceId: 'ws_brk',
        slug: 'broken',
        versionId: 'v-broken',
      })
    } finally {
      cap.restore()
    }
  })

  it('serialises against a concurrent saveCanvas that adds a new file reference', async () => {
    // Race scenario: user has foo.png on disk left over from an earlier
    // session, but no canvas references it yet. They open a canvas and
    // add an image element pointing at foo. Just as that saveCanvas is
    // committing, a background purgeDanglingFiles fires.
    //
    // Without a workspace write barrier, GC's collectReferencedFileIds
    // could observe the pre-save state (no references) and unlink
    // foo.png. With the lock, the save commits first and the purge
    // pass sees the new reference.
    await seedFile('ws_race', 'about-to-reference', '.png', 200)

    const empty = new LoroDoc()
    await saveCanvas('ws_race', 'page', empty)

    // Build the post-save doc by extending the empty doc.
    const next = await import('./canvas-store.js').then((m) => m.loadCanvas('ws_race', 'page'))
    const list = next.getMovableList('elements')
    const map = list.insertContainer(0, new LoroMap())
    map.set('id', 'el-late-binding')
    map.set('type', 'image')
    map.set('fileId', 'about-to-reference')
    map.set('isDeleted', false)
    next.commit()

    // Kick the save first so it acquires the lock; then kick the purge.
    const savePromise = saveCanvas('ws_race', 'page', next, { overwrite: true })
    const purgePromise = purgeDanglingFiles('ws_race')
    const [, purgeResult] = await Promise.all([savePromise, purgePromise])

    expect(purgeResult.purgedCount).toBe(0)
    const remaining = (await readdir(join(tempDir, 'ws_race', 'files'))).sort()
    expect(remaining).toEqual(['about-to-reference.png'])
  })
})
