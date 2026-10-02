import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeSpatialCanvas } from '@kamiazya/whiteboard-loro-adapter'
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
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

const { compactWorkspace, loadDocument, saveDocument } = await import('./document-store.js')
const { FileVersionStore } = await import('./version-store.js')
const { createIsolatedDb } = await import('./db/test-helpers.js')
const { makeSpatialDoc } = await import('../../shared/test-utils/spatial-doc.js')
const { stallCeilingMs } = await import('../background-work-costs.js')
const { measureLoopAvailability, measureSchedulingFloor } = await import(
  '../../shared/test-utils/loop-availability.js'
)

let handle: Awaited<ReturnType<typeof createIsolatedDb>>

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'wb-compact-loop-'))
  handle = await createIsolatedDb({ dataDir: tempDir })
})
afterEach(async () => {
  await handle.dispose()
  await rm(tempDir, { recursive: true, force: true })
})

function canvasOf(round: number, nodes: number): SpatialCanvas {
  return {
    nodes: Array.from({ length: nodes }, (_unused, i) =>
      textNode({
        id: `node-${i}`,
        text: `r${round} node ${i}`,
        x: i,
        y: i,
        width: 100,
        height: 60,
      }),
    ),
    edges: [],
  }
}

/**
 * A workspace whose record has history behind its earliest version: the one
 * thing a compaction folds. One version is taken first, then the document is
 * rewritten `edits` times, so the shallow snapshot is smaller than the log.
 */
async function seedWorkspace(
  workspaceId: string,
  store: InstanceType<typeof FileVersionStore>,
  edits: number,
): Promise<void> {
  const path = 'board'
  await saveDocument(workspaceId, path, makeSpatialDoc(canvasOf(0, 40)), { kind: 'spatial' })
  await store.save(workspaceId, path, await loadDocument(workspaceId, path), {
    auto: false,
    label: 'floor',
  })
  for (let round = 1; round <= edits; round++) {
    const doc = await loadDocument(workspaceId, path)
    writeSpatialCanvas(doc, canvasOf(round, 40))
    await saveDocument(workspaceId, path, doc, { overwrite: true })
  }
}

/** Ten sampler intervals of work, at least. */
const MIN_PASS_MS = 30

/**
 * Rewrites of one document behind the version floor; the stall tracks the
 * record's history. The fixture starts here and DOUBLES until a pass is long
 * enough for the sampler to say something, because a fixed count is a
 * threshold on the machine rather than on the code: a runner fast enough to
 * fold 100 rewrites in 28ms reads as the guard never reaching its subject.
 * The cap is still well under the ceiling (400 rewrites read 425ms by hand).
 */
const EDITS = 100
const MAX_EDITS = 400

/** Readings per fixture, ODD so the median is the middle element. */
const READINGS = 3

let workspaceSeq = 0

/**
 * What one auto-compaction costs the loop that is serving requests, which is
 * the answer `background-work-costs.ts` declares for it.
 *
 * `compactWorkspace` exports a shallow snapshot of the whole workspace record
 * and rewrites it under the in-process lock, so it is ONE call that cannot be
 * subdivided: the stall is the whole pass, and it grows with the record's
 * history rather than with how many documents the workspace holds. That is
 * tolerable at its trigger — a compaction lands thirty seconds after the last
 * write to a workspace, not during it — and is what the ceiling pins, so a
 * regression to something that holds the loop for seconds fails here.
 */
describe('what an auto-compaction costs the loop that is serving requests', () => {
  it('stays under the ceiling its registry declaration names', async () => {
    const store = new FileVersionStore()
    // One compaction nobody reads: the first one in a process pays for loading
    // the WASM export path and warming the store, which is not what a daemon
    // that has been running for a day charges its loop.
    await readAt(store, 10, 1)

    let edits = EDITS
    let readings = await readAt(store, edits, READINGS)
    while (median(readings, (r) => r.elapsedMs) < MIN_PASS_MS && edits < MAX_EDITS) {
      edits *= 2
      readings = await readAt(store, edits, READINGS)
    }

    const stalls = readings.map((r) => r.worstStallMs).sort((a, b) => a - b)
    const detail = `${edits} edits, stalls ${stalls.join('/')}ms`
    process.stdout.write(`auto-compact: ${detail}\n`)

    // The fixture is long enough for the sampler to say something: a pass of a
    // couple of intervals would report a tiny stall whether or not it held the
    // loop, and a guard that never reaches its subject reads like one that
    // checked. The growth loop above is what makes this hold on a fast
    // machine; here it fails only when the cap itself is too small.
    expect(
      median(readings, (r) => r.elapsedMs),
      detail,
    ).toBeGreaterThanOrEqual(MIN_PASS_MS)
    const floor = await measureSchedulingFloor(median(readings, (r) => r.elapsedMs))
    expect(
      median(readings, (r) => r.worstStallMs),
      `${detail}, machine floor ${floor.worstStallMs}ms`,
    ).toBeLessThan(stallCeilingMs('auto-compact') + floor.worstStallMs)
  }, 120_000)
})

type Reading = { elapsedMs: number; worstStallMs: number }

async function readAt(
  store: InstanceType<typeof FileVersionStore>,
  edits: number,
  count: number,
): Promise<Reading[]> {
  const readings: Reading[] = []
  while (readings.length < count) {
    const workspaceId = `compact-${edits}-${workspaceSeq++}`
    await seedWorkspace(workspaceId, store, edits)
    const { result, availability } = await measureLoopAvailability(
      () => compactWorkspace(workspaceId, store),
      { intervalMs: 5 },
    )
    // The measurement is of a compaction that HAPPENED: one that declined
    // would report a stall of nothing, and pass.
    expect(result.compacted, `declined: ${result.reason}`).toBe(true)
    readings.push({ elapsedMs: availability.elapsedMs, worstStallMs: availability.worstStallMs })
  }
  return readings
}

function median(readings: readonly Reading[], of: (r: Reading) => number): number {
  const values = readings.map(of).sort((a, b) => a - b)
  return values[(values.length - 1) / 2] as number
}
