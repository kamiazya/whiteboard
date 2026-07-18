import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { decodeFrontiers, encodeFrontiers, LoroDoc, LoroMap } from 'loro-crdt'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let tempDir: string

vi.mock('../config.js', () => ({
  get DATA_DIR() {
    return tempDir
  },
  getDataDir: () => tempDir,
  WHITEBOARD_ROOT: '/tmp/whiteboard',
  REPO_ROOT: '/tmp',
}))

const { saveCanvas, loadCanvas } = await import('./canvas-store.js')
const { purgeDanglingFiles, IncompleteFileGcScanError } = await import('./file-gc.js')
const { isCorruptStoredDataError } = await import('./corrupt-stored-data.js')
const { captureLogsForTests } = await import('../log.js')
const { FileVersionStore } = await import('./version-store.js')
const { createBranch, loadCanvasBranches, saveCanvasBranches, updateBranchTip } = await import(
  './branches-store.js'
)
const { createIsolatedDb } = await import('./db/test-helpers.js')

let handle: Awaited<ReturnType<typeof createIsolatedDb>>

async function seedFile(
  workspaceId: string,
  fileId: string,
  ext: string,
  bytes: number,
): Promise<void> {
  const dir = join(tempDir, workspaceId, 'files')
  await mkdir(dir, { recursive: true })
  const path = join(dir, `${fileId}${ext}`)
  await writeFile(path, Buffer.alloc(bytes, 0xab))
  // Age the file beyond the default GC grace window so existing
  // dangling-files tests see the unlink path. Tests that exercise the
  // grace window itself create files without calling seedFile (or use
  // seedFreshFile below).
  const past = (Date.now() - 2 * 60 * 60 * 1000) / 1000
  await utimes(path, past, past)
}

async function seedFreshFile(
  workspaceId: string,
  fileId: string,
  ext: string,
  bytes: number,
): Promise<void> {
  const dir = join(tempDir, workspaceId, 'files')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, `${fileId}${ext}`), Buffer.alloc(bytes, 0xcd))
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

  it('skips files whose mtime is within the configured grace window (Race C)', async () => {
    // The upload-but-not-yet-saveCanvas race: routes/files.ts has just
    // written `pending.png` to disk, but the user has not yet called
    // saveCanvas with the matching image element. Without a grace
    // window GC fires here and permanently deletes a file that was
    // about to be referenced. With the default 1-hour grace, freshly-
    // touched files are spared.
    await seedFreshFile('ws_grace', 'pending', '.png', 64)
    await seedFile('ws_grace', 'old-orphan', '.png', 32)

    const result = await purgeDanglingFiles('ws_grace')
    // old-orphan is past the grace window, gone. pending is fresh —
    // preserved this round.
    expect(result.purgedCount).toBe(1)
    const remaining = (await readdir(join(tempDir, 'ws_grace', 'files'))).sort()
    expect(remaining).toEqual(['pending.png'])
  })

  it('honours an explicit graceMs=0 to bypass the grace window', async () => {
    // Operators who run a manual cleanup right after deciding nothing
    // should be deferred can pass graceMs: 0 to delete fresh dangling
    // files in the same call. Used by the tests above for the same
    // reason.
    await seedFreshFile('ws_grace0', 'fresh-orphan', '.png', 16)
    const result = await purgeDanglingFiles('ws_grace0', { graceMs: 0 })
    expect(result.purgedCount).toBe(1)
    const remaining = await readdir(join(tempDir, 'ws_grace0', 'files'))
    expect(remaining).toEqual([])
  })

  it('reads the grace window from WHITEBOARD_FILE_GC_GRACE_MS when no option is set', async () => {
    const previous = process.env.WHITEBOARD_FILE_GC_GRACE_MS
    process.env.WHITEBOARD_FILE_GC_GRACE_MS = '0'
    try {
      await seedFreshFile('ws_env', 'fresh-orphan', '.png', 8)
      const result = await purgeDanglingFiles('ws_env')
      expect(result.purgedCount).toBe(1)
    } finally {
      if (previous === undefined) delete process.env.WHITEBOARD_FILE_GC_GRACE_MS
      else process.env.WHITEBOARD_FILE_GC_GRACE_MS = previous
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

  it('keeps a file referenced only by a non-head branch tip', async () => {
    // Image element lives at the point where "feature" branches off.
    const doc = makeDocWithImage('branch-only-image')
    await saveCanvas('ws_branch', 'page', doc)
    const branchTip = Buffer.from(encodeFrontiers(doc.frontiers())).toString('base64')
    await createBranch('ws_branch', 'page', { name: 'feature', initialTipFrontiers: branchTip })

    // At head (main), the image element is removed — main's live state no
    // longer references it, but "feature"'s tip still does.
    const live = await loadCanvas('ws_branch', 'page')
    const list = live.getMovableList('elements')
    list.delete(0, list.length)
    live.commit()
    await saveCanvas('ws_branch', 'page', live, { overwrite: true })

    await seedFile('ws_branch', 'branch-only-image', '.png', 42)

    const result = await purgeDanglingFiles('ws_branch', { graceMs: 0 })
    expect(result.purgedCount).toBe(0)
    const remaining = (await readdir(join(tempDir, 'ws_branch', 'files'))).sort()
    expect(remaining).toEqual(['branch-only-image.png'])
  })

  it('refuses to purge with a corrupt_stored_data failure when a branch tip cannot be checked out', async () => {
    // Unlike a version load failure (ambiguous cause, retryable 503), a
    // branch tip that fails to decode/checkout means the persisted bytes
    // themselves are corrupt — no retry fixes that, so this must surface
    // as CorruptStoredDataError (mapped to 500 corrupt_stored_data by the
    // route), not the retryable IncompleteFileGcScanError (503).
    await saveCanvas('ws_brk2', 'broken-branch', makeDocWithImage('only-by-broken-branch'))
    await createBranch('ws_brk2', 'broken-branch', {
      name: 'feature',
      initialTipFrontiers: 'not-valid-base64-frontiers!!',
    })
    await seedFile('ws_brk2', 'only-by-broken-branch', '.png', 111)
    await seedFile('ws_brk2', 'really-dangling-2', '.png', 22)

    await expect(purgeDanglingFiles('ws_brk2', { graceMs: 0 })).rejects.toSatisfy(
      isCorruptStoredDataError,
    )

    const remaining = (await readdir(join(tempDir, 'ws_brk2', 'files'))).sort()
    expect(remaining).toEqual(['only-by-broken-branch.png', 'really-dangling-2.png'])
  })

  it('refuses to purge when a listed version cannot be loaded at all (returns null)', async () => {
    // A silent `if (past) collectFromDoc(...)` skip is equivalent to
    // treating a version we could not load as "referencing nothing" —
    // the same permanent-data-loss hazard as a thrown load() error.
    await saveCanvas('ws_nullver', 'page', makeDocWithImage('only-by-null-version'))
    await seedFile('ws_nullver', 'only-by-null-version', '.png', 55)
    await seedFile('ws_nullver', 'really-dangling-3', '.png', 11)

    const fakeStore = {
      list: async () => [
        {
          id: 'v-missing',
          slug: 'page',
          createdAt: '2026-04-25T00:00:00.000Z',
          elementCount: 1,
          auto: false,
          hasThumbnail: false,
          branchName: 'main',
        },
      ],
      load: async () => null,
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
      purgeDanglingFiles('ws_nullver', { versionStore: fakeStore as any, graceMs: 0 }),
    ).rejects.toBeInstanceOf(IncompleteFileGcScanError)

    const remaining = (await readdir(join(tempDir, 'ws_nullver', 'files'))).sort()
    expect(remaining).toEqual(['only-by-null-version.png', 'really-dangling-3.png'])
  })

  it('serialises purge against a concurrent updateBranchTip (GC-vs-branch-write race)', async () => {
    // The mirror image of the saveCanvas race above: a branch tip is
    // updated (e.g. after a commit on that branch) concurrently with a
    // purge pass. Without branches-store also taking the workspace write
    // lock, the purge could snapshot branch state before the tip update
    // lands and unlink a file the new tip references.
    const doc = makeDocWithImage('about-to-be-tip-referenced')
    await saveCanvas('ws_branch_race', 'page', doc)
    await createBranch('ws_branch_race', 'page', { name: 'feature' })
    const branchTip = Buffer.from(encodeFrontiers(doc.frontiers())).toString('base64')

    // Head (main) no longer references the image — only the about-to-land
    // "feature" tip update will.
    const live = await loadCanvas('ws_branch_race', 'page')
    const liveList = live.getMovableList('elements')
    liveList.delete(0, liveList.length)
    live.commit()
    await saveCanvas('ws_branch_race', 'page', live, { overwrite: true })

    await seedFile('ws_branch_race', 'about-to-be-tip-referenced', '.png', 77)

    // updateBranchTip's own async read (loadCanvasBranches) happens before
    // it reaches the lock, which would make lock-acquisition order
    // non-deterministic under Promise.all. Pre-compute the next branches
    // state here (mirroring exactly what updateBranchTip does internally)
    // so the race below starts both sides at the same synchronous point —
    // saveCanvasBranches is the single write path updateBranchTip funnels
    // through, so this exercises the identical lock.
    const preRaceState = await loadCanvasBranches('ws_branch_race', 'page')
    const idx = preRaceState.branches.findIndex((b) => b.name === 'feature')
    const nextState = {
      ...preRaceState,
      branches: [
        ...preRaceState.branches.slice(0, idx),
        { ...preRaceState.branches[idx]!, tipFrontiers: branchTip },
        ...preRaceState.branches.slice(idx + 1),
      ],
    }

    const updatePromise = saveCanvasBranches('ws_branch_race', 'page', nextState)
    const purgePromise = purgeDanglingFiles('ws_branch_race', { graceMs: 0 })
    const [, purgeResult] = await Promise.all([updatePromise, purgePromise])

    expect(purgeResult.purgedCount).toBe(0)
    const remaining = (await readdir(join(tempDir, 'ws_branch_race', 'files'))).sort()
    expect(remaining).toEqual(['about-to-be-tip-referenced.png'])
  })

  it('serialises purge against updateBranchTip called through its real production path', async () => {
    // Unlike the test above (which precomputes state to sidestep
    // updateBranchTip's own unlocked read), this drives updateBranchTip
    // itself. updateBranchTip must acquire the workspace write lock
    // before it reads the current branch state — otherwise GC can
    // acquire the lock first despite starting second, scan the state
    // before the tip lands, and permanently delete the file the new
    // tip is about to reference.
    const doc = makeDocWithImage('about-to-be-tip-referenced-live')
    await saveCanvas('ws_branch_race_live', 'page', doc)
    await createBranch('ws_branch_race_live', 'page', { name: 'feature' })
    const branchTip = Buffer.from(encodeFrontiers(doc.frontiers())).toString('base64')

    // Head (main) no longer references the image — only the about-to-land
    // "feature" tip update will.
    const live = await loadCanvas('ws_branch_race_live', 'page')
    const liveList = live.getMovableList('elements')
    liveList.delete(0, liveList.length)
    live.commit()
    await saveCanvas('ws_branch_race_live', 'page', live, { overwrite: true })

    await seedFile('ws_branch_race_live', 'about-to-be-tip-referenced-live', '.png', 77)

    // Kick updateBranchTip first so it should win the lock if its entire
    // read-modify-write is inside the workspace write barrier.
    const updatePromise = updateBranchTip('ws_branch_race_live', 'page', 'feature', branchTip)
    const purgePromise = purgeDanglingFiles('ws_branch_race_live', { graceMs: 0 })
    const [, purgeResult] = await Promise.all([updatePromise, purgePromise])

    expect(purgeResult.purgedCount).toBe(0)
    const remaining = (await readdir(join(tempDir, 'ws_branch_race_live', 'files'))).sort()
    expect(remaining).toEqual(['about-to-be-tip-referenced-live.png'])
  })

  it('serialises purge against the real PUT /head route (HEAD-switch tipFrontiers persist race)', async () => {
    // The multi-step production HEAD-switch flow (read state -> capture
    // current frontiers -> checkout -> save canvas -> save branches) must
    // run as a single atomic unit against file-gc. Without a lock spanning
    // the whole thing, a purge could interleave right after the live doc
    // has moved to the new HEAD (no longer referencing the image) but
    // before the outgoing HEAD's captured frontiers are persisted — and
    // see the file as unreferenced by either state.
    const { createBranchesRouter } = await import('../routes/branches.js')

    // "feature" branches off an earlier, image-free point in the SAME
    // doc's history, so its tip is a real, checkoutable frontiers value.
    const doc = new LoroDoc()
    doc.commit()
    const baselineFrontiers = doc.frontiers()
    const featureTip = Buffer.from(encodeFrontiers(baselineFrontiers)).toString('base64')

    const list = doc.getMovableList('elements')
    const map = list.insertContainer(0, new LoroMap())
    map.set('id', 'el-head-race')
    map.set('type', 'image')
    map.set('fileId', 'about-to-be-captured-on-head-switch')
    map.set('isDeleted', false)
    doc.commit()

    await saveCanvas('ws_head_race', 'page', doc)
    await createBranch('ws_head_race', 'page', {
      name: 'feature',
      initialTipFrontiers: featureTip,
    })
    await seedFile('ws_head_race', 'about-to-be-captured-on-head-switch', '.png', 90)

    const app = createBranchesRouter({
      getCurrentFrontiers: async (sid, slug) => {
        const live = await loadCanvas(sid, slug)
        return Buffer.from(encodeFrontiers(live.frontiers())).toString('base64')
      },
      checkoutTo: async (sid, slug, tipFrontiersBase64) => {
        const live = await loadCanvas(sid, slug)
        const clone = LoroDoc.fromSnapshot(live.export({ mode: 'snapshot' }))
        const targetFrontiers = decodeFrontiers(
          new Uint8Array(Buffer.from(tipFrontiersBase64, 'base64')),
        )
        clone.checkout(targetFrontiers)
        await saveCanvas(sid, slug, clone, { overwrite: true })
      },
    })

    const putHeadPromise = app.request('/api/workspaces/ws_head_race/canvases/page/head', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ branch: 'feature' }),
    })
    const purgePromise = purgeDanglingFiles('ws_head_race', { graceMs: 0 })
    const [headRes, purgeResult] = await Promise.all([putHeadPromise, purgePromise])

    expect(headRes.status).toBe(200)
    expect(purgeResult.purgedCount).toBe(0)
    const remaining = (await readdir(join(tempDir, 'ws_head_race', 'files'))).sort()
    expect(remaining).toEqual(['about-to-be-captured-on-head-switch.png'])
  })
})
