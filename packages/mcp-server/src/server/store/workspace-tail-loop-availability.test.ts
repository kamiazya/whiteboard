import { writeSpatialCanvas } from '@kamiazya/whiteboard-loro-adapter'
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { newImageRef } from '@kamiazya/whiteboard-model'
import { DocumentStoreWorkspaceDocs } from '@kamiazya/whiteboard-workspace-index'
import { LoroDoc } from 'loro-crdt'
import { describe, expect, it } from 'vitest'
import {
  loopTurnShare,
  measureLoopAvailability,
} from '../../shared/test-utils/loop-availability.js'
import { InMemoryDocumentStore } from './inmemory/in-memory-document-store.js'
import { createWorkspaceTail } from './workspace-tail.js'

function canvasReferencing(prefix: string, nodes: number): SpatialCanvas {
  return {
    nodes: Array.from({ length: nodes }, (_unused, i) => ({
      id: `node-${i}`,
      type: 'file' as const,
      file: newImageRef(`${prefix}-${i}`),
      x: i,
      y: i,
      width: 100,
      height: 100,
    })),
    edges: [],
  }
}

/**
 * Ten sampler intervals of work, at least — below that "the loop got a turn"
 * is a statement about timer granularity rather than about this pass.
 */
const MIN_PASS_MS = 50

/**
 * What the workspace tail costs the loop that is serving requests, which is
 * the answer `background-work.ts` declares for it.
 *
 * `catchUp` imports the record's new updates into the live document every
 * subscriber is reading, and that is a synchronous WASM call. The `await`s
 * around it read exactly like awaits on a socket and never reach the timer
 * phase, so before the per-workspace yield a pass was one unbroken stall for
 * as long as every subscribed workspace took together — measured over 10
 * workspaces with real history: 80.1ms elapsed, 80.1ms blocked, and the 5ms
 * sampler landed ZERO times. With the yield, on the same fixture, 9 samples
 * and a 6.6ms worst stall.
 *
 * Smaller than file-GC's seconds by two orders of magnitude, and it matters
 * for the opposite reason: this one runs on the operator's chosen interval,
 * so its stall is paid over and over rather than once a night.
 *
 * The store here is in-memory, which makes the measurement CONSERVATIVE in
 * the direction that counts: a real libSQL read might let a tick land between
 * workspaces, but the import itself blocks either way, and it is the import
 * this bounds.
 */
describe('a workspace-tail pass', () => {
  it('keeps handing the event loop back between workspaces', async () => {
    const docs = new DocumentStoreWorkspaceDocs(new InMemoryDocumentStore())
    const live = new Map<string, LoroDoc>()
    const subscribed: string[] = []
    let emitted = 0
    const tail = createWorkspaceTail({
      subscribedWorkspaces: () => subscribed,
      docs,
      liveDoc: async (workspaceId) => live.get(workspaceId) as LoroDoc,
      emit: () => {
        emitted += 1
      },
      intervalMs: 50,
    })

    // The fixture GROWS until a pass is long enough for the answer to mean
    // anything: a pass finishing inside a couple of sampler intervals would
    // report a tiny worst-stall whether it yielded or not.
    let availability: Awaited<ReturnType<typeof measureLoopAvailability<void>>>['availability'] =
      undefined as never
    for (let round = 0; round < 5; round++) {
      for (let i = 0; i < 8 * 2 ** round; i++) {
        const workspaceId = `ws-${round}-${i}`
        const doc = new LoroDoc()
        for (let r = 0; r < 30; r++) {
          writeSpatialCanvas(doc, canvasReferencing(`${workspaceId}r${r}`, 60))
          doc.commit()
        }
        await docs.save(workspaceId, doc)
        live.set(workspaceId, LoroDoc.fromSnapshot(doc.export({ mode: 'snapshot' })))
        subscribed.push(workspaceId)
      }
      // A first pass over a newly subscribed workspace BASELINES rather than
      // catching up, so the measured pass below has to be the second one —
      // otherwise this measures `readCursor` and nothing else, which is the
      // vacuous version of this test.
      await tail.pollOnce()
      for (const workspaceId of subscribed) {
        const stored = (await docs.open(workspaceId)) as LoroDoc
        for (let r = 0; r < 10; r++) {
          writeSpatialCanvas(stored, canvasReferencing(`${workspaceId}late${r}`, 60))
          stored.commit()
        }
        await docs.save(workspaceId, stored)
      }

      availability = (await measureLoopAvailability(() => tail.pollOnce(), { intervalMs: 5 }))
        .availability
      if (availability.elapsedMs > MIN_PASS_MS) break
    }

    // Reached, not assumed — and the pass really caught something up rather
    // than baselining past every workspace.
    expect(availability.elapsedMs).toBeGreaterThan(MIN_PASS_MS)
    expect(emitted).toBeGreaterThan(0)

    // Without the yield this fixture produced ZERO samples: the loop ran
    // nothing at all for the whole pass. A SHARE rather than a count, for the
    // reason `loopTurnShare` gives -- this pass is short enough that the ideal
    // sample count is around ten, so the absolute 5 it replaces demanded half
    // of them, and CI failed on `expected 5 to be greater than 5`. Measured
    // here: 0.55 idle, 0.37 under load.
    expect(loopTurnShare(availability)).toBeGreaterThan(0.05)
    expect(availability.worstStallMs).toBeLessThan(availability.elapsedMs * 0.5)
  }, 120_000)
})
