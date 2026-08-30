import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeSpatialCanvas } from '@kamiazya/whiteboard-loro-adapter'
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { newImageRef } from '@kamiazya/whiteboard-model'
import { DocumentStoreWorkspaceDocs } from '@kamiazya/whiteboard-workspace-index'
import { LoroDoc } from 'loro-crdt'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { measureLoopAvailability } from '../../shared/test-utils/loop-availability.js'
import { createIsolatedDb } from './db/test-helpers.js'
import { LibsqlDocumentStore } from './libsql/libsql-document-store.js'
import { createWorkspaceTail } from './workspace-tail.js'

let root: string
let handle: Awaited<ReturnType<typeof createIsolatedDb>>

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wb-tail-loop-'))
  // File-backed, through the production dialect. An in-memory store measured
  // this at 6.6ms and a real one at 8.1ms on the same fixture — close enough
  // to look interchangeable, and they are not: what the number tracks is the
  // size of the record being caught up, and only a real store carries one.
  handle = await createIsolatedDb({ dataDir: join(root, 'data'), memory: false })
})
afterEach(async () => {
  await handle.dispose()
  await rm(root, { recursive: true, force: true })
})

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

/** Ten sampler intervals of work, at least. */
const MIN_PASS_MS = 50

/**
 * What the workspace tail costs the loop that is serving requests, which is
 * the answer `background-work.ts` declares for it.
 *
 * `catchUp` imports what the record gained into the live document every
 * subscriber is reading, and that import is a synchronous WASM call. The
 * `await`s around it read exactly like awaits on a socket and never reach the
 * timer phase, so before the per-workspace yield a pass was one unbroken
 * stall for as long as every subscribed workspace took together.
 *
 * Measured over 10 workspaces against a file-backed libSQL store, by removing
 * the yield: at 30 commits of history and a 50-commit gain, 331.4ms elapsed
 * and 331.4ms blocked with ZERO sampler ticks; at 300 and 50, **2927ms** —
 * three seconds of daemon, on every interval the operator chose.
 *
 * With the yield the stall becomes ONE workspace's catch-up, and that is the
 * floor: an import is a single call and cannot be subdivided, so the only way
 * further down is to batch what `catchUp` imports. What one workspace costs
 * is what this grows with, not how many there are:
 *
 * | history | gain | elapsed | blocked | worst stall |
 * |---------|------|---------|---------|-------------|
 * | 30      | 10   | 80.4ms  | 35.4ms  | 7.7ms       |
 * | 100     | 10   | 227.2ms | 182.2ms | 27.3ms      |
 * | 100     | 50   | 562.4ms | 517.4ms | 105.4ms     |
 * | 300     | 50   | 1390ms  | 1345ms  | 282.8ms     |
 *
 * The aggregate stays ~97% blocked and is meant to: the work is CPU-bound and
 * the yield buys BOUNDED LATENCY, not less load. 300 commits of history is a
 * small workspace, so 282.8ms is a floor on what a real one pays rather than
 * a ceiling — which is why the declaration names the fixture instead of
 * carrying a bare number.
 *
 * A ratio rather than a duration, for the reason `snapshot-blocking.test.ts`
 * gives: "the loop keeps getting turns" is stable across machines in a way a
 * millisecond figure is not.
 */
describe('a workspace-tail pass', () => {
  it('keeps handing the event loop back between workspaces', async () => {
    const docs = new DocumentStoreWorkspaceDocs(new LibsqlDocumentStore(handle.db))
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
    // anything: one finishing inside a couple of sampler intervals would
    // report a tiny worst-stall whether it yielded or not.
    let availability: Awaited<ReturnType<typeof measureLoopAvailability<void>>>['availability'] =
      undefined as never
    for (let round = 0; round < 4; round++) {
      for (let i = 0; i < 4 * 2 ** round; i++) {
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
      // catching up, so the measured pass has to be the second one —
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
    expect(subscribed.length).toBeGreaterThanOrEqual(4)

    // A turn per workspace, give or take — which is the claim, and is why
    // this is relative to the fixture rather than an absolute count.
    //
    // It was `> 5` and that coupled two quantities that vary independently:
    // the loop above exits on ELAPSED time, while with the yield the sample
    // count tracks the WORKSPACE count. So whether round 0's four workspaces
    // land above or below the floor silently decided whether the assertion
    // was reachable at all. Measured: 42.9ms and 3 samples locally, which
    // continued to round 0's twelve and passed, against 4 workspaces and 3
    // samples on CI, which exited and failed. Same code, same assertion,
    // opposite verdicts, and neither was about the yield.
    //
    // Without the yield this produces ZERO samples at any fixture size, which
    // is what the assertion is really for.
    expect(availability.samples).toBeGreaterThanOrEqual(subscribed.length / 2)
    expect(availability.worstStallMs).toBeLessThan(availability.elapsedMs * 0.5)
  }, 300_000)
})
