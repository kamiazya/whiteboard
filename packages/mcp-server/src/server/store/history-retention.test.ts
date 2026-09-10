/**
 * What retiring the branch did to the two mechanics that decide what the
 * daemon keeps — the record of a measurement, kept as a test so the state it
 * describes cannot quietly change back.
 *
 * Branch tips reached into compaction's shallow-snapshot cut and into
 * file-GC's reference collect. Neither is visible in the diff that removed
 * them: the code simply stops consulting rows that no longer exist, and the
 * numbers move somewhere nobody looked. So they were measured FIRST, on one
 * fixture built twice, with the branch row and without it:
 *
 * | metric                            | with a tip | without |
 * |-----------------------------------|-----------:|--------:|
 * | folded record, bytes              |  1475-1487 | 846-866 |
 * | files reclaimed (only-on-the-tip) |          0 |       1 |
 *
 * Six runs each. The compaction gap decomposed as roughly 195 bytes of branch
 * metadata carried on the record itself and roughly 435 bytes of history the
 * pin held back — measured by making the cut ignore pins, which brought the
 * "with" arm to 1045-1062. Both halves are gone now, and the surviving column
 * is what this file asserts.
 *
 * The file-GC row was never a delta. It is a behaviour difference: a file
 * that only a branch tip referenced used to be retained and is now reclaimed.
 * That is correct — with the row gone nothing can reach it — and it is still
 * a deletion, so it is asserted rather than assumed.
 */
import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { LoroDoc } from 'loro-crdt'
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

const { saveDocument, compactDocument } = await import('./document-store.js')
const { clearCache } = await import('./doc-cache.js')
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

it('compaction folds to the earliest version alone, with nothing holding it back', async () => {
  const WS = 'ws-unpinned'
  await saveDocument(WS, 'doc', canvasDoc('early content'), { kind: 'spatial' })
  // The number of later edits is what makes the fold a real gain rather than
  // a rounding error, and it is the count the measurement above was taken at.
  for (let i = 0; i < 30; i++) {
    await saveDocument(WS, 'doc', canvasDoc(`later content ${'x'.repeat(200)} ${i}`), {
      kind: 'spatial',
      overwrite: true,
    })
  }
  const versionStore = new FileVersionStore()
  await versionStore.save(WS, 'doc', canvasDoc('later content'), { auto: false, label: 'only' })

  const result = await compactDocument(WS, 'doc', versionStore)
  expect(result.reason).toBe('ok')

  // A ceiling rather than an exact pin, because these bytes are NOT
  // deterministic: Loro mints a random peer id per document and its encoding
  // moves the snapshot by a few. Measured over six runs at 846-866, so 1000
  // is comfortably clear of the noise and far under the 1475-1487 a single
  // branch pin used to cost — this fails loudly if a second pin ever returns.
  expect(result.afterBytes).toBeLessThan(1000)
  expect(result.afterBytes).toBeGreaterThan(0)
})

it('reclaims a file that only a past state of the document references', async () => {
  const WS = 'ws-files'
  await seedAgedFile(WS, 'no-longer-drawn', 4096)
  await saveDocument(WS, 'doc', makeSpatialDocWithImage('no-longer-drawn'), { kind: 'spatial' })

  // The live document moves on and drops the image. With no version row and
  // no branch tip, nothing reaches it any more.
  await saveDocument(WS, 'doc', canvasDoc('no image any more'), {
    kind: 'spatial',
    overwrite: true,
  })

  const { purgedCount } = await purgeDanglingFiles(WS)
  expect(purgedCount).toBe(1)
  await expect(readdir(join(tempDir, WS, 'files'))).resolves.toEqual([])
})
