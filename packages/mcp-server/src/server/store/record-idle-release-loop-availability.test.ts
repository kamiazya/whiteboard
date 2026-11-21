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
    const snapshot = workspaceSnapshot(360)
    recordIdleReleaseWorker.start()
    let released = 0
    let done: () => void = () => {}
    const allReleased = new Promise<void>((resolve) => {
      done = resolve
    })
    const records = new RecordCache<RecordLease>({
      maxEntries: 4,
      idleMs: 50,
      schedule: scheduleIdleRelease,
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
    // The wait itself is idle time, so the turn share is high; what the
    // ceiling below holds is the single longest stretch the sweep ran.
    expect(loopTurnShare(availability)).toBeGreaterThan(0.05)
    const floor = await measureSchedulingFloor(availability.elapsedMs, { intervalMs: 5 })
    expect(
      availability.worstStallMs,
      `worst ${availability.worstStallMs}ms, machine floor ${floor.worstStallMs}ms`,
    ).toBeLessThanOrEqual(stallCeilingMs('record-idle-release') + floor.worstStallMs)
  }, 60_000)
})
