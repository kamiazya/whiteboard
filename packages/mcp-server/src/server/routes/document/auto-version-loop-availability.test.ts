import { writeSpatialCanvas } from '@kamiazya/whiteboard-loro-adapter'
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { LoroDoc } from 'loro-crdt'
import { describe, expect, it, vi } from 'vitest'
import type { LoopAvailability } from '../../../shared/test-utils/loop-availability.js'
import { measureLoopAvailability } from '../../../shared/test-utils/loop-availability.js'
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
    nodes: Array.from({ length: nodes }, (_unused, i) => ({
      id: `node-${i}`,
      type: 'text' as const,
      text: `node ${i}`,
      x: i,
      y: i,
      width: 100,
      height: 60,
    })),
    edges: [],
  }
}

/** Ten sampler intervals of work, at least. */
const MIN_PASS_MS = 50

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
    let measured = await runOnce(store, nodes)
    // Grow until the pass is long enough for the sampler to say anything —
    // an absolute fixture size is a statement about this machine.
    while (measured.availability.elapsedMs < MIN_PASS_MS && nodes < 8000) {
      nodes *= 2
      measured = await runOnce(store, nodes)
    }

    // The measurement is of a checkpoint that HAPPENED. A flush that saved
    // nothing would report a stall of nothing, and pass.
    expect(measured.saved).toBe(1)
    expect(measured.availability.elapsedMs).toBeGreaterThanOrEqual(MIN_PASS_MS)
    expect(measured.availability.worstStallMs).toBeLessThan(stallCeilingMs('auto-checkpoint'))
  })
})

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
