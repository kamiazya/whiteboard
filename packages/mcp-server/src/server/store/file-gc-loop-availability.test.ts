import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
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

const { newImageRef } = await import('@kamiazya/whiteboard-model')
const { writeSpatialCanvas } = await import('@kamiazya/whiteboard-loro-adapter')
const { loadDocument, saveDocument } = await import('./document-store.js')
const { purgeDanglingFiles } = await import('./file-gc.js')
const { FileVersionStore } = await import('./version-store.js')
const { createIsolatedDb } = await import('./db/test-helpers.js')
const { makeSpatialDoc } = await import('../../shared/test-utils/spatial-doc.js')
const { measureLoopAvailability } = await import('../../shared/test-utils/loop-availability.js')

let handle: Awaited<ReturnType<typeof createIsolatedDb>>

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'wb-gc-loop-'))
  handle = await createIsolatedDb({ dataDir: tempDir })
})
afterEach(async () => {
  await handle.dispose()
  await rm(tempDir, { recursive: true, force: true })
})

/** A canvas whose nodes all reference uploads, so the scan has real work. */
function canvasReferencing(prefix: string, nodes: number): SpatialCanvas {
  return {
    nodes: Array.from({ length: nodes }, (_unused, i) => ({
      id: `node-${i}`,
      type: 'file' as const,
      file: newImageRef(`${prefix}-${i}`),
      x: i * 10,
      y: i * 10,
      width: 100,
      height: 100,
    })),
    edges: [],
  }
}

/** Documents with a version history, which is what the scan walks. */
async function seedWorkspace(
  workspaceId: string,
  store: InstanceType<typeof FileVersionStore>,
  round: number,
  documents: number,
  versionsEach: number,
): Promise<void> {
  for (let d = 0; d < documents; d++) {
    const path = `page-${round}-${d}`
    await saveDocument(workspaceId, path, makeSpatialDoc(canvasReferencing(`r${round}d${d}`, 40)))
    for (let v = 0; v < versionsEach; v++) {
      const doc = await loadDocument(workspaceId, path)
      await store.save(workspaceId, path, doc, { auto: false, label: `v${v}` })
      // Move the document on, so each version is a distinct point in the
      // record's history rather than the same state saved twice.
      writeSpatialCanvas(doc, canvasReferencing(`r${round}d${d}v${v}`, 40))
      await saveDocument(workspaceId, path, doc, { overwrite: true })
    }
  }
}

async function seedDanglingFile(workspaceId: string, name: string): Promise<void> {
  const dir = join(tempDir, workspaceId, 'files')
  await mkdir(dir, { recursive: true })
  const path = join(dir, name)
  await writeFile(path, Buffer.alloc(1024, 0xab))
  // Older than the grace window, so the pass reaches the unlink.
  const past = (Date.now() - 2 * 60 * 60 * 1000) / 1000
  await utimes(path, past, past)
}

/**
 * Ten sampler intervals of work, at least. Below that "the loop got a turn"
 * is a statement about timer granularity rather than about this pass.
 */
const MIN_PASS_MS = 300

/**
 * `background-work.ts` declares what each background worker costs the loop
 * that is serving requests, and for the file-GC sweeper that answer is this
 * test.
 *
 * The pass is CPU-bound and always will be — it forks and checks out the
 * workspace record once per branch and once per version of every document,
 * and every one of those is a synchronous WASM call. So the number that
 * matters is not the total, which cannot go down, but the longest CONTIGUOUS
 * stretch: that is what a request arriving mid-pass waits, and it is the
 * difference between a daemon that is busy and a daemon that is gone.
 *
 * Measured on this test's own fixture, by removing the yields: 1394ms
 * elapsed, 1379ms of it with the loop running nothing, in ONE 1342ms stall —
 * the sampler landed 3 times in the whole pass. With the yields, on the same
 * fixture, 61 samples and a worst stall of 38.8ms. A larger fixture only
 * widens it: 5 documents at 20 versions each blocked for 7404ms unbroken.
 *
 * Nothing in the source said so — `await versionStore.load(...)` reads exactly
 * like an await on a socket, and the microtasks it resolves through never
 * reach the timer phase. This is the same shape as the hot snapshot pinned by
 * `db/snapshot-blocking.test.ts`, and it went the other way: a snapshot is
 * handed to a subprocess, while a purge cannot be, because the write barrier
 * that protects it from a concurrent save is in-process.
 *
 * A ratio rather than a duration, for the reason `snapshot-blocking.test.ts`
 * gives: "the loop keeps getting turns" is stable across machines in a way
 * "the worst stall is 38.8ms" is not.
 */
describe('a file-GC pass', () => {
  it('keeps handing the event loop back while it scans', async () => {
    const store = new FileVersionStore()

    // The fixture GROWS until the pass is long enough for the answer to mean
    // anything. A pass that finishes inside a couple of sampler intervals
    // would report a tiny worst-stall whether it yielded or not — a guard
    // that never reaches its subject reads exactly like one that checked.
    let measured: Awaited<
      ReturnType<typeof measureLoopAvailability<Awaited<ReturnType<typeof purgeDanglingFiles>>>>
    > = undefined as never
    let scanned = 0
    for (let attempt = 0; attempt < 4; attempt++) {
      // Doubling, so a fast machine reaches the floor in a round or two
      // rather than creeping. Each round adds NEW documents — the pass walks
      // everything seeded so far, so the fixture only grows.
      const documents = 2 * 2 ** attempt
      await seedWorkspace('ws_loop', store, attempt, documents, 8)
      scanned += documents
      // A fresh one each round: the previous pass unlinked the last one, and
      // an EMPTY files directory makes `purgeDanglingFiles` return before the
      // scan this test is about — measured, the growth loop otherwise reports
      // 123ms for a fixture of 240 versions, because only the first round
      // scanned anything at all.
      await seedDanglingFile('ws_loop', `orphan-${attempt}.png`)
      measured = await measureLoopAvailability(
        () => purgeDanglingFiles('ws_loop', { versionStore: store }),
        { intervalMs: 5 },
      )
      if (measured.availability.elapsedMs > MIN_PASS_MS) break
    }
    const { availability } = measured

    // Reached, not assumed.
    expect(availability.elapsedMs).toBeGreaterThan(MIN_PASS_MS)
    expect(scanned).toBeGreaterThan(0)
    // The pass reached the unlink, so the scan above it really ran. Without
    // this the whole assertion can be satisfied by an early return.
    expect(measured.result).toMatchObject({ purgedCount: 1 })

    // The loop ran something many times over, rather than once at each edge.
    //
    // A FRACTION of the samples the interval asked for, not a count, for the
    // same reason the stall assertion below is a ratio: a count is a
    // statement about how busy the machine is. Measured on this fixture --
    // without the yields, 3 samples of an ideal 279 (1.1%); with them, 61 of
    // 173 idle (35%) and 20 of 85 under eight CPU hogs on four cores (24%).
    // A floor at 5% clears the blocked case by 4x and the loaded case by 5x.
    // The absolute 20 this replaces had NO margin: a loaded run landed on
    // exactly 20 and CI failed `expected 20 to be greater than 20`.
    expect(availability.samples).toBeGreaterThan(
      (availability.elapsedMs / availability.intervalMs) * 0.05,
    )
    // And no single stall swallowed the pass. Without the yields this ratio
    // was 0.96; with them it is 0.04 on the same fixture.
    expect(availability.worstStallMs).toBeLessThan(availability.elapsedMs * 0.5)
  }, 120_000)
})
