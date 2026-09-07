/**
 * What a branch pin COSTS, priced before the branch surface is retired.
 *
 * Branch tips reach into two mechanics that decide what the daemon keeps:
 * compaction's `retainedHistoryCut` holds the shallow-snapshot cut back to
 * the pointwise minimum across every tip, and file-GC counts every tip's
 * checkout as a live reference set. Both are correct while a person can
 * switch to a branch. Neither is visible in a diff that removes branches —
 * the code simply stops consulting rows that no longer exist, and the
 * numbers move somewhere nobody looked.
 *
 * So this file measures the pin itself, on ONE fixture built twice: with the
 * branch row and without it. Same documents, same edits, same version row,
 * same seeded files — the only difference is the row. Both numbers are
 * pinned EXACTLY, not as a ceiling, so retiring branches has to edit them
 * and say why.
 *
 * What each arm claims:
 *
 * - `compaction` is a **delta**: a tip older than the earliest version row
 *   holds history the fold would otherwise drop, so the record stays larger.
 * - `file-gc` is NOT a delta — it is a behaviour difference. A file that only
 *   a branch tip references is retained with the row and reclaimed without
 *   it. Retiring branches therefore makes such a file collectable, which is
 *   correct (nothing can reach it any more) and is a deletion, so it is
 *   measured rather than asserted.
 */
import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { encodeFrontiers, type LoroDoc } from 'loro-crdt'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

let tempDir: string
vi.mock('../config.js', () => ({
  get DATA_DIR() {
    return tempDir
  },
  getDataDir: () => tempDir,
  WHITEBOARD_ROOT: '/tmp/whiteboard',
  REPO_ROOT: '/tmp',
}))

const { saveDocument, compactDocument, openWorkspaceDocIfStored } = await import(
  './document-store.js'
)
const { clearCache } = await import('./doc-cache.js')
const { createBranch } = await import('./branches-store.js')
const { purgeDanglingFiles } = await import('./file-gc.js')
const { FileVersionStore } = await import('./version-store.js')
const { createIsolatedDb } = await import('./db/test-helpers.js')
const { makeSpatialDoc, makeSpatialDocWithImage } = await import(
  '../../shared/test-utils/spatial-doc.js'
)

let handle: Awaited<ReturnType<typeof createIsolatedDb>>

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'branch-pin-price-'))
  handle = await createIsolatedDb({ dataDir: tempDir })
  clearCache()
})
afterEach(async () => {
  await handle.dispose()
  await rm(tempDir, { recursive: true, force: true })
})

function base64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64')
}

function canvasDoc(text: string): LoroDoc {
  return makeSpatialDoc({
    nodes: [{ id: 'n1', type: 'text', x: 0, y: 0, width: 80, height: 40, text }],
    edges: [],
  })
}

/** Seeded past the default GC grace window, so a dangling file really unlinks. */
async function seedAgedFile(workspaceId: string, fileId: string, bytes: number): Promise<void> {
  const dir = join(tempDir, workspaceId, 'files')
  await mkdir(dir, { recursive: true })
  const path = join(dir, `${fileId}.png`)
  await writeFile(path, Buffer.alloc(bytes, 0xab))
  const past = (Date.now() - 2 * 60 * 60 * 1000) / 1000
  await utimes(path, past, past)
}

/**
 * A workspace whose history has moved well past a point worth pinning, with
 * exactly one version row recorded at the END. `withBranch` decides whether
 * that earlier point is also recorded as a branch tip.
 *
 * The number of later edits is what makes the fold a real gain rather than a
 * rounding error, and 30 is the count `compact-branch-pin.test.ts` already
 * uses for the same reason.
 */
async function seedWorkspace(
  workspaceId: string,
  { withBranch }: { withBranch: boolean },
): Promise<void> {
  await saveDocument(workspaceId, 'doc', canvasDoc('branch-era content'), { kind: 'spatial' })

  const atBranch = await openWorkspaceDocIfStored(workspaceId)
  if (atBranch === null) throw new Error('workspace record was not stored')
  const tipFrontiers = atBranch.frontiers()
  if (withBranch) {
    await createBranch(workspaceId, 'doc', {
      name: 'old-work',
      initialTipFrontiers: base64(encodeFrontiers(tipFrontiers)),
    })
  }

  for (let i = 0; i < 30; i++) {
    await saveDocument(workspaceId, 'doc', canvasDoc(`later content ${'x'.repeat(200)} ${i}`), {
      kind: 'spatial',
      overwrite: true,
    })
  }
}

it('prices what a branch pin holds back from compaction', async () => {
  const measure = async (withBranch: boolean): Promise<number> => {
    const ws = withBranch ? 'ws-pinned' : 'ws-unpinned'
    await seedWorkspace(ws, { withBranch })
    const versionStore = new FileVersionStore()
    await versionStore.save(ws, 'doc', canvasDoc('later content'), { auto: false, label: 'only' })
    const result = await compactDocument(ws, 'doc', versionStore)
    expect(result.reason).toBe('ok')
    return result.afterBytes
  }

  const pinned = await measure(true)
  const unpinned = await measure(false)

  // The DIRECTION is the durable claim: a tip older than every version row
  // can only hold the cut BACK, never push it forward, so the folded record
  // is larger with the row than without it.
  expect(pinned).toBeGreaterThan(unpinned)

  // The magnitude, as a band rather than an exact pin, because these bytes
  // are NOT deterministic: Loro mints a random peer id per document and its
  // encoding moves the snapshot by a few bytes. Measured over six runs before
  // writing this: pinned 1475-1487 (spread 12, 0.8%), unpinned 846-866 (spread
  // 20, 2.4%), ratio 1.71-1.75. So one tip, one document and 30 later edits
  // leave the folded record ~75% larger, two orders of magnitude above the
  // run-to-run noise. The band is +-0.15 around that measured range: loud if
  // the effect changes size, quiet for the peer id.
  //
  // What the gap CONTAINS, measured by making the cut ignore pins (three runs,
  // pinned 1045-1062 against the same unpinned 848-864): roughly 195 bytes is
  // the branch plane's own content on the record, and roughly 435 is history
  // the pin holds back. Worth separating because the first half would be there
  // even if the cut were free — and both halves go when branches do.
  expect(pinned / unpinned).toBeGreaterThan(1.6)
  expect(pinned / unpinned).toBeLessThan(1.9)
})

it('prices the files a branch pin keeps alive', async () => {
  const measure = async (withBranch: boolean): Promise<number> => {
    const ws = withBranch ? 'ws-files-pinned' : 'ws-files-unpinned'
    // The image is referenced by the document as it stood at the branch
    // point, and by nothing afterwards.
    await seedAgedFile(ws, 'only-on-the-branch', 4096)
    await saveDocument(ws, 'doc', makeSpatialDocWithImage('only-on-the-branch'), {
      kind: 'spatial',
    })

    const atBranch = await openWorkspaceDocIfStored(ws)
    if (atBranch === null) throw new Error('workspace record was not stored')
    if (withBranch) {
      await createBranch(ws, 'doc', {
        name: 'old-work',
        initialTipFrontiers: base64(encodeFrontiers(atBranch.frontiers())),
      })
    }

    // The live document moves on and drops the image.
    await saveDocument(ws, 'doc', canvasDoc('no image any more'), {
      kind: 'spatial',
      overwrite: true,
    })

    const { purgedCount } = await purgeDanglingFiles(ws)
    const left = await readdir(join(tempDir, ws, 'files')).catch(() => [] as string[])
    expect(left.length).toBe(1 - purgedCount)
    return purgedCount
  }

  // Not a delta — a behaviour difference. With the row the file is reachable
  // by checking the branch out, so file-GC keeps it; without the row nothing
  // can reach it, so file-GC reclaims it.
  expect({ pinned: await measure(true), unpinned: await measure(false) }).toEqual({
    pinned: 0,
    unpinned: 1,
  })
})
