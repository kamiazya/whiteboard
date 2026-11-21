import {
  createWorkspaceDocumentAtPath,
  documentContainers,
  leaseKind,
  loadCrdtEngine,
  type RecordLease,
  writeMarkdownBody,
} from '@kamiazya/whiteboard-loro-adapter'
import { LoroDoc } from 'loro-crdt'
import { afterEach, describe, expect, it } from 'vitest'
import {
  loopTurnShare,
  measureLoopAvailability,
  measureSchedulingFloor,
} from '../../shared/test-utils/loop-availability.js'
import { stallCeilingMs } from '../background-work-costs.js'
import { RecordCache } from './record-cache.js'
import { recordIdleReleaseWorker, scheduleIdleRelease } from './record-idle-release.js'

afterEach(async () => {
  await recordIdleReleaseWorker.stop()
})

const PROSE = 'A paragraph of ordinary prose about a workspace and what is in it. '.repeat(40)

/**
 * Built once per file. Building it leaves thousands of wasm wrappers whose
 * finalizers run on this loop some turns later; built per run, a repeat's
 * finalizers landed in the NEXT run's window and read as a 125-177ms stall of a
 * sweep whose four releases take about 1ms in all.
 */
let snapshot: Uint8Array | undefined

function workspaceSnapshot(documents: number): Uint8Array {
  const record = new LoroDoc()
  for (let i = 0; i < documents; i += 1) {
    const documentId = `01ARZ3NDEKTSV4RRFF${String(i).padStart(8, '0')}`
    createWorkspaceDocumentAtPath(record, { path: `d${i}`, documentId, kind: 'markdown' })
    writeMarkdownBody(documentContainers(record, documentId), PROSE)
  }
  record.commit()
  return new Uint8Array(record.export({ mode: 'snapshot' }))
}

/**
 * What giving back the records nobody used costs the loop that is serving
 * requests, which is the answer `background-work.ts` declares for it.
 *
 * Every record goes idle together, so the pass releases all of them in one
 * sweep, which is the worst case the bound allows (it holds four leases). Each
 * release is one engine call and cannot be subdivided.
 */
describe('the idle release of workspace records', () => {
  it('stays inside the declared stall ceiling while it gives a full cache back', async () => {
    const kind = leaseKind(loadCrdtEngine)
    snapshot ??= workspaceSnapshot(360)
    recordIdleReleaseWorker.start()
    let released = 0
    let sweepMs = 0
    let done: () => void = () => {}
    const allReleased = new Promise<void>((resolve) => {
      done = resolve
    })
    const records = new RecordCache<RecordLease>({
      maxEntries: 4,
      idleMs: 250,
      // The sweep runs synchronously inside the scheduled callback, so its
      // own duration is exactly the stall it imposes on the loop.
      schedule: (run, ms) =>
        scheduleIdleRelease(() => {
          const startedAt = performance.now()
          run()
          sweepMs = Math.max(sweepMs, performance.now() - startedAt)
        }, ms),
      release: (record) => {
        kind.release(record)
        released += 1
        if (released === 4) done()
      },
      pinned: () => false,
    })
    for (let i = 0; i < 4; i += 1) records.keep(`k${i}`, `w${i}`, await kind.load(snapshot, []))

    const { availability } = await measureLoopAvailability(() => allReleased, { intervalMs: 5 })

    expect(released).toBe(4)
    expect(records.size).toBe(0)
    // The wait itself is idle time, so the loop kept getting turns.
    expect(loopTurnShare(availability)).toBeGreaterThan(0.05)
    // The ceiling is held against the sweep's own duration, not the window's
    // worst stall: the window also catches pauses that are not the sweep's —
    // the stress job's repeats read 121.9ms there while the four releases took
    // about 1ms — and charging those to this worker made the ceiling a
    // statement about the machine. The window's worst stall stays in the
    // message for whoever reads a failure.
    const floor = await measureSchedulingFloor(availability.elapsedMs, { intervalMs: 5 })
    expect(
      sweepMs,
      `sweep ${sweepMs.toFixed(1)}ms; window worst ${availability.worstStallMs}ms, machine floor ${floor.worstStallMs}ms`,
    ).toBeLessThanOrEqual(stallCeilingMs('record-idle-release') + floor.worstStallMs)
  }, 60_000)
})
