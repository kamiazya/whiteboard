import { writeSpatialCanvas } from '@kamiazya/whiteboard-loro-adapter'
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { LoroDoc } from 'loro-crdt'
import { describe, expect, it, vi } from 'vitest'
import type { LoopAvailability } from '../../../shared/test-utils/loop-availability.js'
import {
  measureLoopAvailability,
  measureSchedulingFloor,
} from '../../../shared/test-utils/loop-availability.js'
import { withTempDataDir } from '../_test-helpers.js'

const tmp = withTempDataDir('whiteboard-auto-version-loop-')

vi.mock('../../config.js', () => ({
  get DATA_DIR() {
    return tmp.dir
  },
  getDataDir: () => tmp.dir,
  WHITEBOARD_ROOT: '/tmp/whiteboard',
  REPO_ROOT: '/tmp',
}))

const { createAutoVersionTrigger } = await import('./auto-version.js')
const { FileVersionStore } = await import('../../store/version-store.js')
const { saveDocument, _clearWorkspaceDocCacheForTests } = await import(
  '../../store/document-store.js'
)
const { stallCeilingMs } = await import('../../background-work-costs.js')

function canvasOf(nodes: number): SpatialCanvas {
  return {
    nodes: Array.from({ length: nodes }, (_unused, i) =>
      textNode({ id: `node-${i}`, text: `node ${i}`, x: i, y: i, width: 100, height: 60 }),
    ),
    edges: [],
  }
}

/** Ten sampler intervals of work, at least. */
const MIN_PASS_MS = 50

/** The growth loop's ceiling on the fixture, so a fast machine still stops. */
const MAX_NODES = 8000

/**
 * Readings per fixture, so ONE environmental pause cannot decide the result.
 *
 * A checkpoint is a WASM export plus a native row write, and this instrument
 * measures WALL CLOCK — so a GC, a page-cache miss or a descheduled worker
 * is charged to the checkpoint exactly like real work, and no sampler can
 * tell them apart. CI failed this twice at 527ms and 570.2ms against the
 * 500ms ceiling, either side of a green run on the same code.
 *
 * The obvious reading of that — a machine so loaded that wall clock stops
 * meaning anything — was MEASURED AND REFUTED before this was written. A
 * pure-CPU probe (busy-spin to a `process.cpuUsage` budget, wall/cpu as the
 * ratio) sampled 2867 times underneath a full 368-file `mcp-node` run held
 * p50 1.000 and max 1.308: this machine does not starve a runnable worker,
 * so the contention story cannot be the whole of it.
 *
 * What the measurements DO say is that the growth loop already normalises
 * the reading. It stops at the first size over `MIN_PASS_MS`, so the fixture
 * absorbs how fast the machine is and the reading lands in the same band
 * either way — 71.8ms at 2000 nodes idle, 70.1 and 65.7 at 1000 nodes with
 * the whole project in flight. The declared ceiling therefore has about 7x
 * headroom by construction on ANY machine, and 570ms is not a slower
 * checkpoint, it is a single ~8x outlier inside one pass.
 *
 * A median drops one of those and leaves a real regression exactly where it
 * was: it takes two readings over the ceiling to fail, which is a machine
 * whose timings are not to be trusted anyway — and the message below says so
 * with all three readings rather than the one that lost.
 *
 * Must stay ODD: `median` takes the middle element rather than averaging.
 */
const READINGS = 3

let runSeq = 0

/**
 * What ONE checkpoint costs the loop that is serving requests, which is the
 * answer `background-work.ts` declares for it.
 *
 * A checkpoint re-reads the document and writes a row, and both halves are
 * synchronous: a Loro export is a WASM call and the row write is the same
 * native binding every other store call goes through. The `await`s around
 * them read exactly like awaits on a socket and never reach the timer phase,
 * so a checkpoint is ONE unbroken stall for its whole duration. Measured
 * here, against a real file-backed store, with the sampler recording zero
 * ticks at every size:
 *
 * | nodes | elapsed | worst stall |
 * |-------|---------|-------------|
 * | 250   | 13.2ms  | 13.2ms      |
 * | 500   | 22.3ms  | 22.3ms      |
 * | 1000  | 38.3ms  | 38.3ms      |
 * | 2000  | 69.9ms  | 69.9ms      |
 * | 4000  | 94.7ms  | 94.7ms      |
 *
 * Roughly linear in the size of the document, and there is no yield to add:
 * an export is one call and cannot be subdivided.
 *
 * That is acceptable at this worker's own trigger and worth stating anyway.
 * A checkpoint lands after five minutes of QUIET, which is the cheapest
 * moment available — nobody is mid-stroke, and a request arriving in that
 * window waits one document's export. What the number is really for is the
 * other path: a shutdown flush takes every pending checkpoint back to back,
 * so a daemon holding many edited documents pays the sum of this column
 * before the process exits.
 *
 * There is no `loopTurnShare` assertion here, and its absence is the finding
 * rather than an omission: the share is 0 by construction, because the pass
 * never yields at all.
 */
describe('what a checkpoint costs the loop that is serving requests', () => {
  it('stays under the ceiling its registry declaration names', async () => {
    _clearWorkspaceDocCacheForTests()
    const store = new FileVersionStore()

    let nodes = 250
    let readings = await readAt(store, nodes)
    // Grow until the pass is long enough for the sampler to say anything —
    // an absolute fixture size is a statement about this machine. The
    // decision takes the median for the same reason the assertion does: one
    // pause during the 250-node pass would clear `MIN_PASS_MS` on a document
    // that does not, and every reading after it would be taken on a fixture
    // too small to show a size-dependent regression at all.
    while (median(readings, (a) => a.elapsedMs) < MIN_PASS_MS && nodes < MAX_NODES) {
      nodes *= 2
      readings = await readAt(store, nodes)
    }

    // The measurement is of checkpoints that HAPPENED. A flush that saved
    // nothing would report a stall of nothing, and pass.
    expect(readings.map((reading) => reading.saved)).toEqual(readings.map(() => 1))

    const stalls = readings
      .map((reading) => reading.availability.worstStallMs)
      .sort((a, b) => a - b)
    // Carried into the assertion because the bare comparison names neither
    // the document it measured nor how the readings sat around each other,
    // and those are the two things a failure has to be triaged with. The
    // fixture in particular is invisible otherwise: `expected 570.2 to be
    // less than 500` is the same sentence at 250 nodes and at 8000.
    const detail = `${nodes} nodes, stalls ${stalls.join('/')}ms`

    expect(
      median(readings, (a) => a.elapsedMs),
      detail,
    ).toBeGreaterThanOrEqual(MIN_PASS_MS)
    // Charged against a free-loop reference taken in the same run — see the
    // same line in workspace-tail-loop-availability.test.ts for why a bare
    // number of milliseconds is an assertion about how quiet the machine was.
    const floor = await measureSchedulingFloor(median(readings, (a) => a.elapsedMs))
    expect(
      median(readings, (a) => a.worstStallMs),
      `${detail}, machine floor ${floor.worstStallMs}ms`,
    ).toBeLessThan(stallCeilingMs('auto-checkpoint') + floor.worstStallMs)
  })
})

type Reading = { saved: number; availability: LoopAvailability }

/** Every reading at one fixture size, so no decision here rests on one sample. */
async function readAt(
  store: InstanceType<typeof FileVersionStore>,
  nodes: number,
): Promise<Reading[]> {
  const readings: Reading[] = []
  while (readings.length < READINGS) readings.push(await runOnce(store, nodes))
  return readings
}

/** `READINGS` is odd, so this is the middle element and not an average. */
function median(readings: readonly Reading[], of: (a: LoopAvailability) => number): number {
  const values = readings.map((reading) => of(reading.availability)).sort((a, b) => a - b)
  return values[(values.length - 1) / 2] as number
}

async function runOnce(
  store: InstanceType<typeof FileVersionStore>,
  nodes: number,
): Promise<{ saved: number; availability: LoopAvailability }> {
  const path = `canvas-${nodes}-${runSeq++}`
  const doc = new LoroDoc()
  writeSpatialCanvas(doc, canvasOf(nodes))
  doc.commit()
  await saveDocument('session1', path, doc, { kind: 'spatial' })

  let saved = 0
  const trigger = createAutoVersionTrigger(store, {
    quietMs: 60_000,
    onSaved: () => {
      saved += 1
    },
  })
  trigger('session1', path, doc)
  const { availability } = await measureLoopAvailability(() => trigger.flush(), { intervalMs: 5 })
  return { saved, availability }
}
